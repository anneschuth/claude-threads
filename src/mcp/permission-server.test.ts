import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  handlePermissionWith,
  handleSendFileWith,
  type PermissionHandlerConfig,
  type SendFileHandlerConfig,
} from './permission-server.js';
import type { McpPlatformApi, ReactionEvent } from '../platform/mcp-platform-api.js';
import type { PlatformFormatter } from '../platform/formatter.js';

// =============================================================================
// Test fakes
// =============================================================================

class FakeFormatter implements Partial<PlatformFormatter> {
  formatBold(text: string): string { return `**${text}**`; }
  formatItalic(text: string): string { return `*${text}*`; }
  formatCode(text: string): string { return `\`${text}\``; }
  formatCodeBlock(text: string, lang?: string): string { return `\`\`\`${lang ?? ''}\n${text}\n\`\`\``; }
  formatStrikethrough(text: string): string { return `~~${text}~~`; }
  formatLink(text: string, url: string): string { return `[${text}](${url})`; }
  formatUserMention(username: string): string { return `@${username}`; }
  formatChannelMention(name: string): string { return `#${name}`; }
  formatHeading(text: string): string { return `# ${text}`; }
  formatListItem(text: string): string { return `- ${text}`; }
  formatNumberedListItem(n: number, text: string): string { return `${n}. ${text}`; }
  formatBlockquote(text: string): string { return `> ${text}`; }
  formatHorizontalRule(): string { return '---'; }
  formatTable(): string { return ''; }
  formatEmoji(name: string): string { return `:${name}:`; }
  escape(text: string): string { return text; }
  escapeText(text: string): string { return text; }
  unescape(text: string): string { return text; }
}

interface FakeApiOptions {
  allowedUsers?: string[];
  usernames?: Record<string, string | null>; // userId -> username
  reactions?: Array<ReactionEvent | null>;   // queue of reactions to return; null = timeout
  botUserId?: string;
  postId?: string;
  createPostShouldThrow?: boolean;
  getBotUserIdShouldThrow?: boolean;
}

class FakeApi implements McpPlatformApi {
  public createdPosts: Array<{ message: string; reactions: string[]; threadId?: string }> = [];
  public updatedPosts: Array<{ postId: string; message: string }> = [];
  public waitForReactionCalls: Array<{ postId: string; botUserId: string; timeoutMs: number }> = [];

  private readonly formatter = new FakeFormatter() as unknown as PlatformFormatter;
  private readonly allowedUsers: Set<string>;
  private readonly usernames: Record<string, string | null>;
  private readonly reactions: Array<ReactionEvent | null>;
  private readonly botUserId: string;
  private readonly postId: string;
  private readonly createPostShouldThrow: boolean;
  private readonly getBotUserIdShouldThrow: boolean;

  constructor(opts: FakeApiOptions = {}) {
    this.allowedUsers = new Set(opts.allowedUsers ?? ['alice']);
    this.usernames = opts.usernames ?? { 'u-alice': 'alice' };
    this.reactions = [...(opts.reactions ?? [])];
    this.botUserId = opts.botUserId ?? 'bot-1';
    this.postId = opts.postId ?? 'post-1';
    this.createPostShouldThrow = opts.createPostShouldThrow ?? false;
    this.getBotUserIdShouldThrow = opts.getBotUserIdShouldThrow ?? false;
  }

  getFormatter(): PlatformFormatter { return this.formatter; }
  async getBotUserId(): Promise<string> {
    if (this.getBotUserIdShouldThrow) throw new Error('bot-id-boom');
    return this.botUserId;
  }
  async getUsername(userId: string): Promise<string | null> {
    return userId in this.usernames ? this.usernames[userId] : null;
  }
  isUserAllowed(username: string): boolean { return this.allowedUsers.has(username); }

  async createInteractivePost(message: string, reactions: string[], threadId?: string) {
    if (this.createPostShouldThrow) throw new Error('create-boom');
    this.createdPosts.push({ message, reactions, threadId });
    return { id: this.postId };
  }

  async updatePost(postId: string, message: string): Promise<void> {
    this.updatedPosts.push({ postId, message });
  }

  async waitForReaction(postId: string, botUserId: string, timeoutMs: number): Promise<ReactionEvent | null> {
    this.waitForReactionCalls.push({ postId, botUserId, timeoutMs });
    if (this.reactions.length === 0) return null;
    return this.reactions.shift()!;
  }

  // Outbound file upload — overridden per-test via uploadFileImpl.
  public uploadFileCalls: Array<{ filePath: string; threadId: string; options?: { caption?: string; filename?: string } }> = [];
  public uploadFileImpl: ((filePath: string, threadId: string, options?: { caption?: string; filename?: string }) => Promise<{ postId: string }>) | undefined;
  uploadFile = async (filePath: string, threadId: string, options?: { caption?: string; filename?: string }) => {
    this.uploadFileCalls.push({ filePath, threadId, options });
    if (this.uploadFileImpl) return this.uploadFileImpl(filePath, threadId, options);
    return { postId: 'mock-post-id' };
  };
}

interface HarnessOptions extends FakeApiOptions {
  platformConfigured?: boolean;
  threadId?: string;
  timeoutMs?: number;
  initialAllowAll?: boolean;
  fakeNow?: () => number;
}

function makeCfg(api: FakeApi, opts: HarnessOptions = {}): PermissionHandlerConfig & { getAllowAllState: () => boolean } {
  let allowAll = opts.initialAllowAll ?? false;
  return {
    api,
    threadId: opts.threadId,
    timeoutMs: opts.timeoutMs ?? 120_000,
    platformConfigured: opts.platformConfigured ?? true,
    getAllowAll: () => allowAll,
    setAllowAll: (v) => { allowAll = v; },
    getAllowAllState: () => allowAll,
    now: opts.fakeNow,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('handlePermissionWith', () => {
  it('denies when platform is not configured', async () => {
    const api = new FakeApi();
    const cfg = makeCfg(api, { platformConfigured: false });
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result).toEqual({ behavior: 'deny', message: 'Permission service not configured' });
    expect(api.createdPosts).toHaveLength(0);
  });

  it('auto-allows when allow-all session flag is set', async () => {
    const api = new FakeApi();
    const cfg = makeCfg(api, { initialAllowAll: true });
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(api.createdPosts).toHaveLength(0);
    expect(api.waitForReactionCalls).toHaveLength(0);
  });

  it('allows when authorized user reacts with +1', async () => {
    const api = new FakeApi({
      reactions: [{ postId: 'post-1', userId: 'u-alice', emojiName: '+1' }],
    });
    const cfg = makeCfg(api);
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toEqual({ command: 'ls' });
    expect(cfg.getAllowAllState()).toBe(false);
    expect(api.createdPosts).toHaveLength(1);
    expect(api.updatedPosts).toHaveLength(1);
    expect(api.updatedPosts[0].message).toContain('Allowed');
  });

  it('allows and sets allow-all when authorized user reacts with white_check_mark', async () => {
    const api = new FakeApi({
      reactions: [{ postId: 'post-1', userId: 'u-alice', emojiName: 'white_check_mark' }],
    });
    const cfg = makeCfg(api);
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result.behavior).toBe('allow');
    expect(cfg.getAllowAllState()).toBe(true);
    expect(api.updatedPosts[0].message).toContain('Allowed all');
  });

  it('allow-all sticks across subsequent calls — second call auto-approves without the reaction loop', async () => {
    const api = new FakeApi({
      // Only one queued reaction: used by the FIRST call. If the second call
      // reached `waitForReaction` it would hit the empty queue and time out,
      // causing the assertion on behavior='allow' to fail.
      reactions: [{ postId: 'post-1', userId: 'u-alice', emojiName: 'white_check_mark' }],
    });
    const cfg = makeCfg(api);

    const first = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(first.behavior).toBe('allow');
    expect(cfg.getAllowAllState()).toBe(true);
    expect(api.waitForReactionCalls).toHaveLength(1);
    expect(api.createdPosts).toHaveLength(1);

    const second = await handlePermissionWith('Write', { path: '/tmp/x' }, cfg);
    expect(second.behavior).toBe('allow');
    expect(second.updatedInput).toEqual({ path: '/tmp/x' });
    // Second call short-circuited: no new post, no new reaction poll.
    expect(api.waitForReactionCalls).toHaveLength(1);
    expect(api.createdPosts).toHaveLength(1);
  });

  it('denies when authorized user reacts with -1', async () => {
    const api = new FakeApi({
      reactions: [{ postId: 'post-1', userId: 'u-alice', emojiName: '-1' }],
    });
    const cfg = makeCfg(api);
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result).toEqual({ behavior: 'deny', message: 'User denied permission' });
    expect(api.updatedPosts[0].message).toContain('Denied');
  });

  it('ignores unauthorized user reactions and waits for authorized user', async () => {
    const api = new FakeApi({
      allowedUsers: ['alice'],
      usernames: { 'u-mallory': 'mallory', 'u-alice': 'alice' },
      reactions: [
        { postId: 'post-1', userId: 'u-mallory', emojiName: '+1' }, // unauthorized
        { postId: 'post-1', userId: 'u-alice', emojiName: '+1' },   // authorized
      ],
    });
    const cfg = makeCfg(api);
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result.behavior).toBe('allow');
    // Two polls: first ignored, second accepted
    expect(api.waitForReactionCalls).toHaveLength(2);
  });

  it('ignores reaction when username cannot be resolved', async () => {
    const api = new FakeApi({
      allowedUsers: ['alice'],
      usernames: { 'u-ghost': null, 'u-alice': 'alice' },
      reactions: [
        { postId: 'post-1', userId: 'u-ghost', emojiName: '+1' },
        { postId: 'post-1', userId: 'u-alice', emojiName: '-1' },
      ],
    });
    const cfg = makeCfg(api);
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result.behavior).toBe('deny');
    expect(api.waitForReactionCalls).toHaveLength(2);
  });

  it('times out and denies when waitForReaction returns null', async () => {
    const api = new FakeApi({ reactions: [null] });
    const cfg = makeCfg(api);
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result).toEqual({ behavior: 'deny', message: 'Permission request timed out' });
    expect(api.updatedPosts[0].message).toContain('Timed out');
  });

  it('times out when cumulative elapsed time exceeds timeoutMs', async () => {
    // fake clock: start at 0, then each call advances by 60s; timeout is 100s.
    let fakeTime = 0;
    const ticks = [0, 60_000, 120_000]; // third call exceeds timeout
    const now = () => {
      const t = ticks.length > 0 ? ticks.shift()! : fakeTime;
      fakeTime = t;
      return t;
    };
    const api = new FakeApi({
      allowedUsers: ['alice'],
      usernames: { 'u-mallory': 'mallory' },
      reactions: [
        { postId: 'post-1', userId: 'u-mallory', emojiName: '+1' }, // unauthorized, loop again
      ],
    });
    const cfg = makeCfg(api, { timeoutMs: 100_000, fakeNow: now });
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('Permission request timed out');
  });

  it('denies with error message when API throws during createInteractivePost', async () => {
    const api = new FakeApi({ createPostShouldThrow: true });
    const cfg = makeCfg(api);
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('create-boom');
  });

  it('denies when getBotUserId throws', async () => {
    const api = new FakeApi({ getBotUserIdShouldThrow: true });
    const cfg = makeCfg(api);
    const result = await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('bot-id-boom');
  });

  it('passes the threadId through to createInteractivePost', async () => {
    const api = new FakeApi({
      reactions: [{ postId: 'post-1', userId: 'u-alice', emojiName: '+1' }],
    });
    const cfg = makeCfg(api, { threadId: 'thread-xyz' });
    await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(api.createdPosts[0].threadId).toBe('thread-xyz');
  });

  it('posts with the three canonical reaction options', async () => {
    const api = new FakeApi({
      reactions: [{ postId: 'post-1', userId: 'u-alice', emojiName: '+1' }],
    });
    const cfg = makeCfg(api);
    await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(api.createdPosts[0].reactions).toEqual(['+1', 'white_check_mark', '-1']);
  });

  it('decrements remaining timeout across unauthorized-reaction loop iterations', async () => {
    let t = 0;
    const now = () => t;
    const api = new FakeApi({
      allowedUsers: ['alice'],
      usernames: { 'u-mallory': 'mallory', 'u-alice': 'alice' },
      reactions: [
        { postId: 'post-1', userId: 'u-mallory', emojiName: '+1' },
        { postId: 'post-1', userId: 'u-alice', emojiName: '+1' },
      ],
    });
    const cfg = makeCfg(api, { timeoutMs: 100_000, fakeNow: now });

    // Increment the fake clock between the two waitForReaction calls by hooking the mock
    const origWait = api.waitForReaction.bind(api);
    api.waitForReaction = async (postId, botId, remaining) => {
      t += 30_000;
      return origWait(postId, botId, remaining);
    };

    await handlePermissionWith('Bash', { command: 'ls' }, cfg);
    expect(api.waitForReactionCalls).toHaveLength(2);
    // First call sees full 100s, second call sees 70s remaining.
    expect(api.waitForReactionCalls[0].timeoutMs).toBe(100_000);
    expect(api.waitForReactionCalls[1].timeoutMs).toBe(70_000);
  });

  it('auto-allows the send_file MCP tool without prompting the user', async () => {
    const api = new FakeApi();
    const cfg = makeCfg(api, { initialAllowAll: false });
    const result = await handlePermissionWith(
      'mcp__claude-threads-permissions__send_file',
      { path: '/some/file.png' },
      cfg,
    );
    expect(result.behavior).toBe('allow');
    expect(api.createdPosts).toHaveLength(0); // No approval message posted to thread.
    expect(api.waitForReactionCalls).toHaveLength(0); // No reaction wait.
  });
});

describe('handleSendFileWith', () => {
  let root: string;
  let allowedRoot: string;
  let okFile: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'send-file-test-')));
    allowedRoot = join(root, 'session');
    await mkdir(allowedRoot, { recursive: true });
    okFile = join(allowedRoot, 'screenshot.png');
    await writeFile(okFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeSendFileCfg(api: FakeApi, overrides: Partial<SendFileHandlerConfig> = {}): SendFileHandlerConfig {
    return {
      api,
      threadId: 'THREAD',
      enabled: true,
      allowedRoots: [allowedRoot],
      maxBytes: 10 * 1024 * 1024,
      ...overrides,
    };
  }

  it('uploads a valid file and returns the post id', async () => {
    const api = new FakeApi();
    api.uploadFileImpl = async () => ({ postId: 'POST-123' });
    const result = await handleSendFileWith({ path: okFile, caption: 'look' }, makeSendFileCfg(api));
    expect(result).toEqual({ ok: true, postId: 'POST-123' });
    expect(api.uploadFileCalls).toHaveLength(1);
    expect(api.uploadFileCalls[0].threadId).toBe('THREAD');
    expect(api.uploadFileCalls[0].options?.caption).toBe('look');
    expect(api.uploadFileCalls[0].options?.filename).toBe('screenshot.png');
  });

  it('returns ok:false when feature disabled, without calling uploadFile', async () => {
    const api = new FakeApi();
    const result = await handleSendFileWith({ path: okFile }, makeSendFileCfg(api, { enabled: false }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/disabled/i);
    expect(api.uploadFileCalls).toHaveLength(0);
  });

  it('returns ok:false when threadId is missing', async () => {
    const api = new FakeApi();
    const result = await handleSendFileWith({ path: okFile }, makeSendFileCfg(api, { threadId: '' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/thread/i);
  });

  it('returns ok:false when no allowed roots configured', async () => {
    const api = new FakeApi();
    const result = await handleSendFileWith({ path: okFile }, makeSendFileCfg(api, { allowedRoots: [] }));
    expect(result.ok).toBe(false);
    expect(api.uploadFileCalls).toHaveLength(0);
  });

  it('rejects a path outside the allowed root', async () => {
    const api = new FakeApi();
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'sneak');
    const result = await handleSendFileWith({ path: outside }, makeSendFileCfg(api));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/outside/i);
    expect(api.uploadFileCalls).toHaveLength(0);
  });

  it('returns ok:false when the platform does not implement uploadFile', async () => {
    const api = new FakeApi();
    // Simulate a platform that doesn't support uploads by removing the method.
    (api as unknown as { uploadFile: unknown }).uploadFile = undefined;
    const result = await handleSendFileWith({ path: okFile }, makeSendFileCfg(api));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not support/i);
  });

  it('surfaces upload errors as ok:false with the error message', async () => {
    const api = new FakeApi();
    api.uploadFileImpl = async () => {
      throw new Error('Mattermost 413 file too large');
    };
    const result = await handleSendFileWith({ path: okFile }, makeSendFileCfg(api));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/413.*file too large/);
  });

  it('passes the realpath-resolved path to uploadFile (symlink case)', async () => {
    // Symlink inside the allowed root pointing at okFile — resolved path
    // should be okFile, not the symlink path. Otherwise an attacker could
    // craft a symlink chain that the validator approves but the upload
    // re-reads through.
    const { symlink } = await import('fs/promises');
    const link = join(allowedRoot, 'link.png');
    await symlink(okFile, link);
    const api = new FakeApi();
    api.uploadFileImpl = async () => ({ postId: 'P' });
    await handleSendFileWith({ path: link }, makeSendFileCfg(api));
    expect(api.uploadFileCalls[0].filePath).toBe(okFile);
  });
});
