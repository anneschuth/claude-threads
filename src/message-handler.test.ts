/**
 * Tests for message-handler.ts - Core message handling logic
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { handleMessage, type MessageHandlerOptions } from './message-handler.js';
import type { PlatformClient, PlatformPost, PlatformUser } from './platform/index.js';
import type { SessionManager } from './session/index.js';
import { createMockFormatter } from './test-utils/mock-formatter.js';

// Create mock platform client
function createMockPlatform(botName = 'claude-bot') {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  return {
    createPost: mock(async (message: string, threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: threadId || '',
        createAt: Date.now(),
      };
    }),
    isBotMentioned: mock((message: string) => message.includes(`@${botName}`)),
    extractPrompt: mock((message: string) => message.replace(new RegExp(`@${botName}\\s*`, 'gi'), '').trim()),
    isUserAllowed: mock((username: string) => username === 'allowed-user' || username === 'admin'),
    getBotName: mock(() => botName),
    getFormatter: () => createMockFormatter(),
    disconnect: mock(() => {}),
    posts,
  } as unknown as PlatformClient & { posts: Map<string, string> };
}

// Create mock session manager
function createMockSessionManager() {
  return {
    isInSessionThread: mock(() => false),
    hasPausedSession: mock(() => false),
    isUserAllowedInSession: mock(() => true),
    getActiveThreadIds: mock(() => []),
    getPersistedSession: mock(() => undefined),
    killAllSessionsAndUnpersist: mock(() => {}),
    cancelSession: mock(async () => {}),
    interruptSession: mock(async () => {}),
    inviteUser: mock(async () => {}),
    kickUser: mock(async () => {}),
    enableInteractivePermissions: mock(async () => {}),
    changeDirectory: mock(async () => {}),
    listWorktreesCommand: mock(async () => {}),
    switchToWorktree: mock(async () => {}),
    removeWorktreeCommand: mock(async () => {}),
    disableWorktreePrompt: mock(async () => {}),
    createAndSwitchToWorktree: mock(async () => {}),
    hasPendingWorktreePrompt: mock(() => false),
    handleWorktreeBranchResponse: mock(async () => false),
    sendFollowUp: mock(async () => {}),
    resumePausedSession: mock(async () => {}),
    startSession: mock(async () => {}),
    startSessionWithWorktree: mock(async () => {}),
    requestMessageApproval: mock(async () => {}),
  } as unknown as SessionManager;
}

describe('handleMessage', () => {
  let client: PlatformClient & { posts: Map<string, string> };
  let session: ReturnType<typeof createMockSessionManager>;
  let options: MessageHandlerOptions;

  beforeEach(() => {
    client = createMockPlatform();
    session = createMockSessionManager();
    options = {
      platformId: 'test-platform',
      logger: {
        error: mock(() => {}),
        debug: mock(() => {}),
      },
    };
  });

  describe('!kill command', () => {
    test('executes kill for authorized user', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kill',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'admin', displayName: 'Admin' };

      await handleMessage(client, session, post, user, options);

      expect(session.killAllSessionsAndUnpersist).toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
      expect(onKill).toHaveBeenCalledWith('admin');
    });

    test('rejects kill for unauthorized user', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kill',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'random-user', displayName: 'Random' };

      await handleMessage(client, session, post, user, options);

      expect(session.killAllSessionsAndUnpersist).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });

    test('handles @mention !kill', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !kill',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'admin', displayName: 'Admin' };

      await handleMessage(client, session, post, user, options);

      expect(session.killAllSessionsAndUnpersist).toHaveBeenCalled();
    });
  });

  describe('active session thread', () => {
    beforeEach(() => {
      (session.isInSessionThread as any).mockReturnValue(true);
    });

    test('handles !stop command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!stop',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.cancelSession).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !cancel command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!cancel',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.cancelSession).toHaveBeenCalled();
    });

    test('handles !escape command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!escape',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.interruptSession).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !help command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!help',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Commands');
    });

    test('handles !invite command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!invite @newuser',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.inviteUser).toHaveBeenCalledWith('thread1', 'newuser', 'allowed-user');
    });

    test('handles !kick command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kick @someuser',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.kickUser).toHaveBeenCalledWith('thread1', 'someuser', 'allowed-user');
    });

    test('handles !permissions interactive', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!permissions interactive',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.enableInteractivePermissions).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !cd command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!cd /new/path',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.changeDirectory).toHaveBeenCalledWith('thread1', '/new/path', 'allowed-user');
    });

    test('handles !worktree list', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree list',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.listWorktreesCommand).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !worktree switch <branch>', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree switch feature-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.switchToWorktree).toHaveBeenCalledWith('thread1', 'feature-branch', 'allowed-user');
    });

    test('ignores side conversations', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@someone-else hello!',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).not.toHaveBeenCalled();
    });

    test('sends follow-up for regular messages', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'please help me with this code',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', 'please help me with this code', undefined);
    });

    test('requests approval for unauthorized user', async () => {
      (session.isUserAllowedInSession as any).mockReturnValue(false);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'can I help?',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect(session.requestMessageApproval).toHaveBeenCalledWith('thread1', 'outsider', 'can I help?');
    });
  });

  describe('paused session', () => {
    beforeEach(() => {
      (session.isInSessionThread as any).mockReturnValue(false);
      (session.hasPausedSession as any).mockReturnValue(true);
      (session.getPersistedSession as any).mockReturnValue({
        sessionAllowedUsers: ['allowed-user'],
      });
    });

    test('resumes session for authorized user', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'continue please',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).toHaveBeenCalledWith('thread1', 'continue please', undefined);
    });

    test('rejects resume for unauthorized user', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'continue',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });
  });

  describe('new session', () => {
    test('requires @mention to start', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'help me with code',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSession).not.toHaveBeenCalled();
    });

    test('rejects unauthorized users', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot help',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSession).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });

    test('starts session for authorized user with @mention', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot help me with this',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSession).toHaveBeenCalledWith(
        { prompt: 'help me with this', files: undefined },
        'allowed-user',
        'thread1',
        'test-platform',
        'User'
      );
    });

    test('prompts for message when mention has no content', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSession).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });

    test('handles inline branch syntax "on branch X"', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot on branch feature-x help me',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSessionWithWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.stringMatching(/help me/) }),
        'feature-x',
        'allowed-user',
        'thread1',
        'test-platform',
        'User'
      );
    });

    test('handles inline worktree syntax "!worktree X"', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree my-branch do something',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSessionWithWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.stringMatching(/do something/) }),
        'my-branch',
        'allowed-user',
        'thread1',
        'test-platform',
        'User'
      );
    });
  });

  describe('error handling', () => {
    test('catches and reports errors', async () => {
      (session.startSession as any).mockRejectedValue(new Error('Test error'));

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot help',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(options.logger?.error).toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });
  });
});
