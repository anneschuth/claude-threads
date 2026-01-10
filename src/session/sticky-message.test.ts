import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { buildStickyMessage, StickyMessageConfig, getPendingPrompts, formatPendingPrompts, setShuttingDown, cleanupOldStickyMessages, updateStickyMessage, setStickyPostId, markNeedsBump, initialize } from './sticky-message.js';
import type { Session } from './types.js';
import type { PlatformClient } from '../platform/index.js';
import { mockFormatter } from '../test-utils/mock-formatter.js';

// Default test config
const testConfig: StickyMessageConfig = {
  maxSessions: 5,
  chromeEnabled: false,
  skipPermissions: false,
  worktreeMode: 'prompt',
  workingDir: '/home/user/projects',
  debug: false,
};

// Create a mock platform client
function createMockPlatform(platformId: string): PlatformClient {
  return {
    platformId,
    platformType: 'mattermost',
    displayName: 'Test Platform',
    isUserAllowed: mock(() => true),
    getBotUser: mock(),
    getUser: mock(),
    createPost: mock(),
    updatePost: mock(),
    deletePost: mock(),
    addReaction: mock(),
    createInteractivePost: mock(),
    getPost: mock(),
    getThreadHistory: mock(),
    downloadFile: mock(),
    getFileInfo: mock(),
    getFormatter: mock(),
    getThreadLink: mock((threadId: string) => `/_redirect/pl/${threadId}`),
    connect: mock(),
    disconnect: mock(),
    on: mock(),
    off: mock(),
    emit: mock(),
  } as unknown as PlatformClient;
}

// Create a mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
  const platform = createMockPlatform('test-platform');
  return {
    platformId: 'test-platform',
    threadId: 'thread123',
    sessionId: 'test-platform:thread123',
    claudeSessionId: 'claude-session-id',
    startedBy: 'testuser',
    startedAt: new Date('2024-01-15T10:00:00Z'),
    lastActivityAt: new Date('2024-01-15T10:05:00Z'),
    sessionNumber: 1,
    platform,
    workingDir: '/home/user/projects/myproject',
    claude: { isRunning: () => true, kill: mock(), sendMessage: mock() } as any,
    currentPostId: null,
    currentPostContent: '',
    pendingContent: '',
    pendingApproval: null,
    pendingQuestionSet: null,
    pendingMessageApproval: null,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: null,
    tasksPostId: null,
    lastTasksContent: null,
    tasksCompleted: false,
    tasksMinimized: false,
    activeSubagents: new Map(),
    updateTimer: null,
    typingTimer: null,
    subagentUpdateTimer: null,
    timeoutWarningPosted: false,
    isRestarting: false,
    isCancelled: false,
    isResumed: false,
    wasInterrupted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    firstPrompt: 'Help me with this task',
    statusBarTimer: null,
    ...overrides,
  } as Session;
}

describe('buildStickyMessage', () => {
  // Reset global state before each test
  beforeEach(() => {
    setShuttingDown(false);
  });

  it('shows no active sessions message when empty', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('Active Claude Threads');
    expect(result).toContain('No active sessions');
    expect(result).toContain('Mention me to start a session');
    expect(result).toContain('bun install -g claude-threads');
  });

  it('shows status bar with version and session count', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    // Should contain version (with optional CLI version appended)
    expect(result).toMatch(/`v\d+\.\d+\.\d+( · CLI \d+\.\d+\.\d+)?`/);
    // Should contain session count
    expect(result).toContain('`0/5 sessions`');
    // Should contain uptime
    expect(result).toMatch(/`⏱️ <?\d+[mhd]`/);
  });

  it('shows Chrome status when enabled', async () => {
    const sessions = new Map<string, Session>();
    const chromeConfig = { ...testConfig, chromeEnabled: true };
    const result = await buildStickyMessage(sessions, 'test-platform', chromeConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('`🌐 Chrome`');
  });

  it('hides Chrome status when disabled', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).not.toContain('Chrome');
  });

  it('shows Interactive permission mode by default', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('`🔐 Interactive`');
  });

  it('shows Auto permission mode when skipPermissions is true', async () => {
    const sessions = new Map<string, Session>();
    const autoConfig = { ...testConfig, skipPermissions: true };
    const result = await buildStickyMessage(sessions, 'test-platform', autoConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('`⚡ Auto`');
  });

  it('shows worktree mode when not default prompt', async () => {
    const sessions = new Map<string, Session>();
    const requireConfig = { ...testConfig, worktreeMode: 'require' as const };
    const result = await buildStickyMessage(sessions, 'test-platform', requireConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('`🌿 Worktree: require`');
  });

  it('hides worktree mode when set to prompt (default)', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).not.toContain('Worktree');
  });

  it('shows debug mode when enabled', async () => {
    const sessions = new Map<string, Session>();
    const debugConfig = { ...testConfig, debug: true };
    const result = await buildStickyMessage(sessions, 'test-platform', debugConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('`🐛 Debug`');
  });

  it('shows working directory', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('`📂 /home/user/projects`');
  });

  it('shows active sessions in card-style list', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '@botname Help me debug this function',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('Active Claude Threads');
    expect(result).toContain('(1)');
    expect(result).toContain('▸'); // Active session bullet
    expect(result).toContain('○'); // Status indicator (idle session)
    expect(result).toContain('testuser');
    expect(result).not.toContain('@testuser'); // No @ prefix
    expect(result).toContain('Help me debug this function');
    // Status bar should show 1/5 sessions
    expect(result).toContain('`1/5 sessions`');
  });

  it('truncates long prompts', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: 'This is a very long prompt that should be truncated because it exceeds the maximum length allowed for display in the sticky message table',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('…');
    expect(result.length).toBeLessThan(1000);
  });

  it('removes @mentions from topic', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '@claude-bot @other-user Help me with this',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).not.toContain('@claude-bot');
    expect(result).toContain('Help me with this');
  });

  it('shows sessions from all platforms with cross-platform indicator', async () => {
    const sessions = new Map<string, Session>();

    // Session for test-platform (this platform)
    const session1 = createMockSession({
      platformId: 'test-platform',
      sessionId: 'test-platform:thread1',
      firstPrompt: 'Session 1',
    });
    sessions.set(session1.sessionId, session1);

    // Session for other-platform (different platform)
    const session2 = createMockSession({
      platformId: 'other-platform',
      sessionId: 'other-platform:thread2',
      firstPrompt: 'Session 2',
    });
    sessions.set(session2.sessionId, session2);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    // Now shows all sessions from all platforms (cross-platform visibility)
    expect(result).toContain('(2)');
    expect(result).toContain('Session 1');
    expect(result).toContain('Session 2');
    // Session 1 (this platform) should have a link
    expect(result).toContain('[Session 1]');
    // Session 2 (other platform) should NOT have a link, just plain text
    expect(result).not.toContain('[Session 2]');
    // Session 2 should show the platform name
    expect(result).toContain('Test Platform');
  });

  it('sorts sessions by start time (newest first)', async () => {
    const sessions = new Map<string, Session>();

    const session1 = createMockSession({
      sessionId: 'test-platform:thread1',
      startedAt: new Date('2024-01-15T10:00:00Z'),
      firstPrompt: 'Older session',
    });
    sessions.set(session1.sessionId, session1);

    const session2 = createMockSession({
      sessionId: 'test-platform:thread2',
      startedAt: new Date('2024-01-15T12:00:00Z'),
      firstPrompt: 'Newer session',
    });
    sessions.set(session2.sessionId, session2);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('(2)');
    // Newer session should appear first in the list
    const newerIndex = result.indexOf('Newer session');
    const olderIndex = result.indexOf('Older session');
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  it('shows task progress when available', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (3/7 · 43%)\n✅ Done\n○ Pending',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('3/7');
  });

  it('does not show task progress when no tasks', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: null,
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    // Should not have double dots from missing progress
    expect(result).not.toMatch(/· ·/);
  });

  it('shows active task when in progress', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (2/5 · 40%)\n\n✅ ~~First task~~\n✅ ~~Second task~~\n🔄 **Building the API** (15s)\n○ Fourth task\n○ Fifth task',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('2/5');
    expect(result).toContain('🔄 _Building the API_');
  });

  it('shows active task without elapsed time', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (1/3 · 33%)\n\n✅ ~~Done~~\n🔄 **Running tests**\n○ Deploy',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('1/3');
    expect(result).toContain('🔄 _Running tests_');
  });

  it('does not show active task when all completed', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (3/3 · 100%)\n\n✅ ~~First~~\n✅ ~~Second~~\n✅ ~~Third~~',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('3/3');
    expect(result).not.toContain('🔄');
  });

  it('does not show active task when only pending tasks', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (0/2 · 0%)\n\n○ First task\n○ Second task',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('0/2');
    expect(result).not.toContain('🔄');
  });

  it('handles session without firstPrompt', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: undefined,
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('No topic');
  });

  it('shows "No topic" for bot commands like !worktree', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '!worktree switch sticky-channel-message',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('No topic');
    expect(result).not.toContain('!worktree');
  });

  it('shows "No topic" for !cd commands', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '@botname !cd /some/path',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('No topic');
    expect(result).not.toContain('!cd');
  });

  it('uses sessionTitle when available instead of firstPrompt', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '!worktree switch sticky-channel-message',
      sessionTitle: 'Improve sticky message feature',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('Improve sticky message feature');
    expect(result).not.toContain('No topic');
    expect(result).not.toContain('!worktree');
  });

  it('shows pending plan approval', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('⏳');
    expect(result).toContain('📋 Plan approval');
  });

  it('shows pending question with progress', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingQuestionSet: {
        toolUseId: 'tool1',
        currentIndex: 1,
        currentPostId: 'post1',
        questions: [
          { header: 'Q1', question: 'Question 1', options: [], answer: 'yes' },
          { header: 'Q2', question: 'Question 2', options: [], answer: null },
          { header: 'Q3', question: 'Question 3', options: [], answer: null },
        ],
      },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('⏳');
    expect(result).toContain('❓ Question 2/3');
  });

  it('shows pending message approval', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingMessageApproval: { postId: 'post1', originalMessage: 'Hello', fromUser: 'alice' },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('⏳');
    expect(result).toContain('💬 Message approval');
  });

  it('shows pending worktree prompt', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingWorktreePrompt: true,
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('⏳');
    expect(result).toContain('🌿 Branch name');
  });

  it('shows pending existing worktree prompt', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingExistingWorktreePrompt: {
        postId: 'post1',
        branch: 'feature-branch',
        worktreePath: '/path/to/worktree',
        username: 'alice',
      },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('⏳');
    expect(result).toContain('🌿 Join worktree');
  });

  it('shows pending context prompt', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingContextPrompt: {
        postId: 'post1',
        queuedPrompt: 'Help me',
        threadMessageCount: 10,
        createdAt: Date.now(),
        availableOptions: [3, 5, 10],
      },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('⏳');
    expect(result).toContain('📝 Context selection');
  });

  it('shows multiple pending prompts', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
      pendingMessageApproval: { postId: 'post2', originalMessage: 'Hello', fromUser: 'alice' },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('⏳');
    expect(result).toContain('📋 Plan approval');
    expect(result).toContain('💬 Message approval');
    expect(result).toContain('·'); // Multiple prompts separated by ·
  });

  it('hides active task when pending prompts are shown', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
      lastTasksContent: '📋 **Tasks** (2/5 · 40%)\n\n🔄 **Running tests** (15s)',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    // Should show pending prompt
    expect(result).toContain('📋 Plan approval');
    // Should NOT show active task (pending prompts take priority)
    expect(result).not.toContain('🔄 _Running tests_');
  });

  it('shows active task when no pending prompts', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (2/5 · 40%)\n\n🔄 **Running tests** (15s)',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig, mockFormatter, (threadId) => `/_redirect/pl/${threadId}`);

    expect(result).toContain('🔄 _Running tests_');
    expect(result).not.toContain('⏳');
  });
});

describe('getPendingPrompts', () => {
  it('returns empty array when no pending prompts', () => {
    const session = createMockSession();
    const prompts = getPendingPrompts(session);
    expect(prompts).toEqual([]);
  });

  it('returns plan approval prompt', () => {
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'plan', label: 'Plan approval', emoji: '📋' });
  });

  it('ignores action type approval (only plan)', () => {
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'action', toolUseId: 'tool1' },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toEqual([]);
  });

  it('returns question prompt with progress', () => {
    const session = createMockSession({
      pendingQuestionSet: {
        toolUseId: 'tool1',
        currentIndex: 2,
        currentPostId: 'post1',
        questions: [
          { header: 'Q1', question: 'Q1', options: [], answer: 'yes' },
          { header: 'Q2', question: 'Q2', options: [], answer: 'no' },
          { header: 'Q3', question: 'Q3', options: [], answer: null },
          { header: 'Q4', question: 'Q4', options: [], answer: null },
        ],
      },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'question', label: 'Question 3/4', emoji: '❓' });
  });

  it('returns message approval prompt', () => {
    const session = createMockSession({
      pendingMessageApproval: { postId: 'post1', originalMessage: 'Hello', fromUser: 'alice' },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'message_approval', label: 'Message approval', emoji: '💬' });
  });

  it('returns worktree prompt', () => {
    const session = createMockSession({
      pendingWorktreePrompt: true,
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'worktree', label: 'Branch name', emoji: '🌿' });
  });

  it('returns existing worktree prompt', () => {
    const session = createMockSession({
      pendingExistingWorktreePrompt: {
        postId: 'post1',
        branch: 'feature-branch',
        worktreePath: '/path/to/worktree',
        username: 'alice',
      },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'existing_worktree', label: 'Join worktree', emoji: '🌿' });
  });

  it('returns context prompt', () => {
    const session = createMockSession({
      pendingContextPrompt: {
        postId: 'post1',
        queuedPrompt: 'Help me',
        threadMessageCount: 10,
        createdAt: Date.now(),
        availableOptions: [3, 5, 10],
      },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'context', label: 'Context selection', emoji: '📝' });
  });

  it('returns multiple prompts in order', () => {
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
      pendingMessageApproval: { postId: 'post2', originalMessage: 'Hello', fromUser: 'alice' },
      pendingWorktreePrompt: true,
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(3);
    expect(prompts[0].type).toBe('plan');
    expect(prompts[1].type).toBe('message_approval');
    expect(prompts[2].type).toBe('worktree');
  });
});

describe('formatPendingPrompts', () => {
  it('returns null when no pending prompts', () => {
    const session = createMockSession();
    const result = formatPendingPrompts(session);
    expect(result).toBeNull();
  });

  it('formats single prompt', () => {
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
    });
    const result = formatPendingPrompts(session);
    expect(result).toBe('⏳ 📋 Plan approval');
  });

  it('formats multiple prompts with separator', () => {
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
      pendingMessageApproval: { postId: 'post2', originalMessage: 'Hello', fromUser: 'alice' },
    });
    const result = formatPendingPrompts(session);
    expect(result).toBe('⏳ 📋 Plan approval · 💬 Message approval');
  });
});

describe('cleanupOldStickyMessages', () => {
  it('deletes pinned posts from bot that are not the current sticky', async () => {
    const unpinPost = mock(() => Promise.resolve());
    const deletePost = mock(() => Promise.resolve());
    const getPost = mock((postId: string) => Promise.resolve({
      id: postId,
      userId: 'bot-user-123',
      message: 'old sticky content',
      channelId: 'channel1',
      platformId: 'cleanup-test-1',
    }));
    const getPinnedPosts = mock(() => Promise.resolve(['old-post-1', 'old-post-2', 'current-sticky']));

    const platform = {
      ...createMockPlatform('cleanup-test-1'),
      unpinPost,
      deletePost,
      getPost,
      getPinnedPosts,
    } as unknown as PlatformClient;

    // Set up current sticky so it gets skipped
    setStickyPostId('cleanup-test-1', 'current-sticky');

    // forceRun=true bypasses throttle for testing
    await cleanupOldStickyMessages(platform, 'bot-user-123', true);

    // Should have unpinned and deleted old-post-1 and old-post-2, but not current-sticky
    expect(unpinPost).toHaveBeenCalledTimes(2);
    expect(deletePost).toHaveBeenCalledTimes(2);
    expect(unpinPost).toHaveBeenCalledWith('old-post-1');
    expect(unpinPost).toHaveBeenCalledWith('old-post-2');
    expect(deletePost).toHaveBeenCalledWith('old-post-1');
    expect(deletePost).toHaveBeenCalledWith('old-post-2');
  });

  it('skips posts from other users', async () => {
    const unpinPost = mock(() => Promise.resolve());
    const deletePost = mock(() => Promise.resolve());
    const getPost = mock((postId: string) => Promise.resolve({
      id: postId,
      userId: postId === 'bot-post' ? 'bot-user-123' : 'other-user-456',
      message: 'content',
      channelId: 'channel1',
      platformId: 'cleanup-test-2',
    }));
    const getPinnedPosts = mock(() => Promise.resolve(['bot-post', 'user-post']));

    const platform = {
      ...createMockPlatform('cleanup-test-2'),
      unpinPost,
      deletePost,
      getPost,
      getPinnedPosts,
    } as unknown as PlatformClient;

    // Clear any current sticky
    setStickyPostId('cleanup-test-2', 'some-other-post');

    // forceRun=true bypasses throttle for testing
    await cleanupOldStickyMessages(platform, 'bot-user-123', true);

    // Should only delete the bot's post, not the user's post
    expect(unpinPost).toHaveBeenCalledTimes(1);
    expect(deletePost).toHaveBeenCalledTimes(1);
    expect(unpinPost).toHaveBeenCalledWith('bot-post');
    expect(deletePost).toHaveBeenCalledWith('bot-post');
  });

  it('handles errors gracefully when deleting posts', async () => {
    const unpinPost = mock(() => Promise.reject(new Error('Unpin failed')));
    const deletePost = mock(() => Promise.reject(new Error('Delete failed')));
    const getPost = mock(() => Promise.resolve({
      id: 'post1',
      userId: 'bot-user-123',
      message: 'content',
      channelId: 'channel1',
      platformId: 'cleanup-test-3',
    }));
    const getPinnedPosts = mock(() => Promise.resolve(['post1']));

    const platform = {
      ...createMockPlatform('cleanup-test-3'),
      unpinPost,
      deletePost,
      getPost,
      getPinnedPosts,
    } as unknown as PlatformClient;

    setStickyPostId('cleanup-test-3', 'different-post');

    // Should not throw (forceRun=true bypasses throttle for testing)
    await cleanupOldStickyMessages(platform, 'bot-user-123', true);

    expect(unpinPost).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no pinned posts exist', async () => {
    const unpinPost = mock(() => Promise.resolve());
    const deletePost = mock(() => Promise.resolve());
    const getPost = mock(() => Promise.resolve(null));
    const getPinnedPosts = mock(() => Promise.resolve([]));

    const platform = {
      ...createMockPlatform('cleanup-test-4'),
      unpinPost,
      deletePost,
      getPost,
      getPinnedPosts,
    } as unknown as PlatformClient;

    // forceRun=true bypasses throttle for testing
    await cleanupOldStickyMessages(platform, 'bot-user-123', true);

    expect(unpinPost).not.toHaveBeenCalled();
    expect(deletePost).not.toHaveBeenCalled();
  });
});

describe('updateStickyMessage with bump', () => {
  it('triggers throttled cleanup after creating new sticky post during bump', async () => {
    // Cleanup runs on bump but is throttled (max once per 5 min) and only checks recent posts
    const sessions = new Map<string, Session>();
    // Use a recent Slack-style timestamp for the created post
    const now = Math.floor(Date.now() / 1000);
    const createdPostId = `${now}.123456`;
    const orphanedPostId = `${now - 100}.789012`; // Recent orphaned post

    const createPost = mock(() => Promise.resolve({
      id: createdPostId,
      userId: 'bot-user-123',
      message: 'content',
      channelId: 'channel1',
      platformId: 'test-platform-bump',
    }));
    const updatePost = mock(() => Promise.reject(new Error('Post not found'))); // Force bump
    const pinPost = mock(() => Promise.resolve());
    const unpinPost = mock(() => Promise.resolve());
    const deletePost = mock(() => Promise.resolve());
    const getBotUser = mock(() => Promise.resolve({ id: 'bot-user-123', username: 'bot' }));
    const getPinnedPosts = mock(() => Promise.resolve([orphanedPostId, createdPostId]));
    const getPost = mock((postId: string) => Promise.resolve({
      id: postId,
      userId: 'bot-user-123',
      message: 'content',
      channelId: 'channel1',
      platformId: 'test-platform-bump',
    }));
    const getFormatter = mock(() => mockFormatter);

    const platform = {
      ...createMockPlatform('test-platform-bump'),
      createPost,
      updatePost,
      pinPost,
      unpinPost,
      deletePost,
      getBotUser,
      getPinnedPosts,
      getPost,
      getFormatter,
    } as unknown as PlatformClient;

    // Initialize with a mock session store
    const mockSessionStore = {
      getStickyPostIds: mock(() => new Map()),
      saveStickyPostId: mock(() => {}),
      getHistory: mock(() => []),
    };
    initialize(mockSessionStore as any);

    // Set up existing sticky and mark for bump
    setStickyPostId('test-platform-bump', 'old-sticky-post');
    markNeedsBump('test-platform-bump');

    await updateStickyMessage(platform, sessions, testConfig);

    // Wait a bit for the background cleanup to be triggered
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify new sticky was created
    expect(createPost).toHaveBeenCalled();
    expect(pinPost).toHaveBeenCalled();

    // Verify cleanup was triggered (getBotUser called for cleanup)
    expect(getBotUser).toHaveBeenCalled();

    // Verify cleanup attempted to get pinned posts
    expect(getPinnedPosts).toHaveBeenCalled();
  });
});
