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
    platformId: 'test-platform',
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
  const mockGetActiveThreadIds = mock(() => [] as string[]);
  // Registry mocks - default to not finding sessions
  const mockFindByThreadId = mock(() => undefined);
  const mockGetPersistedByThreadId = mock(() => undefined);
  return {
    // Note: isInSessionThread and hasPausedSession removed - code uses registry directly
    isUserAllowedInSession: mock(() => true),
    getActiveThreadIds: mockGetActiveThreadIds,
    registry: {
      getActiveThreadIds: mockGetActiveThreadIds,
      findByThreadId: mockFindByThreadId,
      getPersistedByThreadId: mockGetPersistedByThreadId,
    },
    getPersistedSession: mock(() => undefined),
    killAllSessions: mock(async () => {}),
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
    cleanupWorktreeCommand: mock(async () => {}),
    createAndSwitchToWorktree: mock(async () => {}),
    hasPendingWorktreePrompt: mock(() => false),
    handleWorktreeBranchResponse: mock(async () => false),
    sendFollowUp: mock(async () => {}),
    resumePausedSession: mock(async () => {}),
    startSession: mock(async () => {}),
    startSessionWithWorktree: mock(async () => {}),
    requestMessageApproval: mock(async () => {}),
    showUpdateStatusWithoutSession: mock(async () => {}),
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

      expect(session.killAllSessions).toHaveBeenCalled();
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

      expect(session.killAllSessions).not.toHaveBeenCalled();
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

      expect(session.killAllSessions).toHaveBeenCalled();
    });
  });

  describe('active session thread', () => {
    beforeEach(() => {
      // Configure registry to return a session object (active session exists)
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
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

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', 'please help me with this code', undefined, 'allowed-user', 'User');
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
      // Configure registry to return a persisted session (paused session exists)
      (session.registry.getPersistedByThreadId as any).mockReturnValue({ sessionAllowedUsers: ['allowed-user'] });
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
        'User',
        'post1',  // triggeringPostId
        {}  // initialOptions
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
        'User',
        'post1',  // triggeringPostId
        {}  // initialOptions
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
        'User',
        'post1',  // triggeringPostId
        {}  // initialOptions
      );
    });

    test('handles !worktree switch in root message - should call switchToWorktree not create worktree', async () => {
      // This tests the bug where "@bot !worktree switch feature-branch" in a root message
      // was incorrectly creating a worktree named "switch" instead of switching to feature-branch
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree switch feature-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      // Should call switchToWorktree with the branch name, NOT startSessionWithWorktree with "switch" as branch
      expect(session.switchToWorktree).toHaveBeenCalledWith('thread1', 'feature-branch', 'allowed-user');
      // Should NOT have tried to create a worktree named "switch"
      expect(session.startSessionWithWorktree).not.toHaveBeenCalled();
    });

    test('handles !worktree list in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree list',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.listWorktreesCommand).toHaveBeenCalledWith('thread1', 'allowed-user');
      expect(session.startSessionWithWorktree).not.toHaveBeenCalled();
    });

    test('handles !worktree remove in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree remove old-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.removeWorktreeCommand).toHaveBeenCalledWith('thread1', 'old-branch', 'allowed-user');
      expect(session.startSessionWithWorktree).not.toHaveBeenCalled();
    });

    test('handles !worktree cleanup in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree cleanup',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.cleanupWorktreeCommand).toHaveBeenCalledWith('thread1', 'allowed-user');
      expect(session.startSessionWithWorktree).not.toHaveBeenCalled();
    });

    test('handles !worktree off in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree off',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.disableWorktreePrompt).toHaveBeenCalledWith('thread1', 'allowed-user');
      expect(session.startSessionWithWorktree).not.toHaveBeenCalled();
    });

    test('handles !worktree switch without branch name in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree switch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.switchToWorktree).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Usage');
    });

    test('handles !worktree remove without branch name in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree remove',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.removeWorktreeCommand).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Usage');
    });

    // Tests for commands that work in the first message
    describe('first message commands', () => {
      test('!help in first message shows help without starting session', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !help',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).not.toHaveBeenCalled();
        expect(client.createPost).toHaveBeenCalled();
        const postContent = (client.createPost as any).mock.calls[0][0];
        expect(postContent).toContain('Commands');  // Help message contains commands
      });

      test('!cd in first message passes workingDir to startSession', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !cd /tmp write a file',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).toHaveBeenCalledWith(
          { prompt: 'write a file', files: undefined },
          'allowed-user',
          'thread1',
          'test-platform',
          'User',
          'post1',
          { workingDir: '/tmp' }  // initialOptions with workingDir
        );
      });

      test('!permissions interactive in first message passes forceInteractivePermissions', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !permissions interactive fix a bug',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).toHaveBeenCalledWith(
          { prompt: 'fix a bug', files: undefined },
          'allowed-user',
          'thread1',
          'test-platform',
          'User',
          'post1',
          { forceInteractivePermissions: true }  // initialOptions with permission flag
        );
      });

      test('!update in first message shows update status without starting session', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !update',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).not.toHaveBeenCalled();
        expect(session.showUpdateStatusWithoutSession).toHaveBeenCalledWith(
          'test-platform',
          'thread1'
        );
      });

      test('combined !cd and !permissions in first message', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !cd /tmp !permissions interactive do something',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).toHaveBeenCalledWith(
          { prompt: 'do something', files: undefined },
          'allowed-user',
          'thread1',
          'test-platform',
          'User',
          'post1',
          { workingDir: '/tmp', forceInteractivePermissions: true }
        );
      });

      test('!release-notes in first message shows release notes without starting session', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !release-notes',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).not.toHaveBeenCalled();
        expect(client.createPost).toHaveBeenCalled();
      });
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

    test('handles null user gracefully', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot help',
        rootId: 'thread1',
        createAt: Date.now(),
      };

      await handleMessage(client, session, post, null, options);

      // Should reject with "unknown" username as unauthorized
      expect(session.startSession).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });
  });

  describe('!permissions auto command', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
    });

    test('rejects upgrade to auto permissions', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!permissions auto',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.enableInteractivePermissions).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Cannot upgrade to auto');
    });
  });

  describe('!worktree commands', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
    });

    test('handles !worktree switch without branch name', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree switch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.switchToWorktree).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Usage');
    });

    test('handles !worktree remove without branch name', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree remove',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.removeWorktreeCommand).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Usage');
    });

    test('handles !worktree off command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree off',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.disableWorktreePrompt).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !worktree cleanup command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree cleanup',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.cleanupWorktreeCommand).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !worktree remove with branch name', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree remove old-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.removeWorktreeCommand).toHaveBeenCalledWith('thread1', 'old-branch', 'allowed-user');
    });
  });

  describe('Claude Code slash commands', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
    });

    test('handles !context command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!context',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', '/context');
    });

    test('handles !cost command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!cost',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', '/cost');
    });

    test('handles !compact command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!compact',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', '/compact');
    });

    test('does not send slash commands for unauthorized user', async () => {
      (session.isUserAllowedInSession as any).mockReturnValue(false);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!context',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).not.toHaveBeenCalled();
    });

    test('handles dynamic slash commands from init event', async () => {
      // Mock session with availableSlashCommands populated from init event
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        availableSlashCommands: new Set(['context', 'cost', 'compact', 'init', 'review', 'security-review']),
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!review',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', '/review');
    });

    test('handles dynamic slash commands with arguments', async () => {
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        availableSlashCommands: new Set(['context', 'cost', 'compact', 'init', 'review']),
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!review --detailed',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', '/review --detailed');
    });

    test('does not pass through unknown commands', async () => {
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        availableSlashCommands: new Set(['context', 'cost', 'compact']),
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!unknowncommand',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      // Unknown command should not be passed through
      expect(session.sendFollowUp).not.toHaveBeenCalled();
    });
  });

  describe('!plugin command', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
      // Add mock for plugin methods
      (session as any).pluginList = mock(() => Promise.resolve());
      (session as any).pluginInstall = mock(() => Promise.resolve());
      (session as any).pluginUninstall = mock(() => Promise.resolve());
    });

    test('handles !plugin list command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin list',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect((session as any).pluginList).toHaveBeenCalledWith('thread1');
    });

    test('handles !plugin without subcommand (defaults to list)', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect((session as any).pluginList).toHaveBeenCalledWith('thread1');
    });

    test('handles !plugin install command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin install context7',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect((session as any).pluginInstall).toHaveBeenCalledWith('thread1', 'context7', 'allowed-user');
    });

    test('handles !plugin uninstall command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin uninstall context7',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect((session as any).pluginUninstall).toHaveBeenCalledWith('thread1', 'context7', 'allowed-user');
    });

    test('shows error when !plugin install missing name', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin install',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
      expect((client.createPost as any).mock.calls[0][0]).toContain('!plugin install <plugin-name>');
    });

    test('shows error when !plugin uninstall missing name', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin uninstall',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
      expect((client.createPost as any).mock.calls[0][0]).toContain('!plugin uninstall <plugin-name>');
    });

    test('shows error for unknown plugin subcommand', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin unknown',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
      expect((client.createPost as any).mock.calls[0][0]).toContain('Unknown subcommand');
    });

    test('does not allow unauthorized users to use plugin commands', async () => {
      (session.isUserAllowedInSession as any).mockReturnValue(false);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin install context7',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect((session as any).pluginInstall).not.toHaveBeenCalled();
    });
  });

  describe('!kill with active sessions', () => {
    test('notifies all active sessions before shutdown', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;
      (session.getActiveThreadIds as any).mockReturnValue(['thread1', 'thread2']);

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

      // Should have posted: 1 confirmation to the kill thread + 2 notifications to active threads
      expect(client.createPost).toHaveBeenCalledTimes(3);
      // First call is the confirmation to the thread where !kill was issued
      expect((client.createPost as any).mock.calls[0][0]).toContain('EMERGENCY SHUTDOWN');
      expect((client.createPost as any).mock.calls[0][0]).toContain('killing 2 active sessions');
      expect(session.killAllSessions).toHaveBeenCalled();
    });

    test('posts confirmation even with no active sessions', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;
      (session.getActiveThreadIds as any).mockReturnValue([]);

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

      // Should have posted confirmation even with no active sessions
      expect(client.createPost).toHaveBeenCalledTimes(1);
      expect((client.createPost as any).mock.calls[0][0]).toContain('killing 0 active sessions');
      expect(session.killAllSessions).toHaveBeenCalled();
    });

    test('does not duplicate notification when kill issued from active session thread', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;
      // The kill is issued from thread1, which is also an active session
      (session.getActiveThreadIds as any).mockReturnValue(['thread1', 'thread2']);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kill',
        rootId: 'thread1', // Kill issued from within an active session
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'admin', displayName: 'Admin' };

      await handleMessage(client, session, post, user, options);

      // Should have posted: 1 confirmation to thread1 + 1 notification to thread2 (not thread1 again)
      expect(client.createPost).toHaveBeenCalledTimes(2);
      // First call is the confirmation (includes session count)
      expect((client.createPost as any).mock.calls[0][0]).toContain('killing 2 active sessions');
      expect((client.createPost as any).mock.calls[0][1]).toBe('thread1');
      // Second call is notification to thread2 only
      expect((client.createPost as any).mock.calls[1][1]).toBe('thread2');
      expect(session.killAllSessions).toHaveBeenCalled();
    });

    test('continues kill even if notifying a thread fails', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;
      (session.getActiveThreadIds as any).mockReturnValue(['thread1', 'thread2']);
      // Make the first createPost call fail
      let callCount = 0;
      (client.createPost as any).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error');
        }
        return { id: 'post_1' };
      });

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

      // Kill should still proceed
      expect(session.killAllSessions).toHaveBeenCalled();
      expect(onKill).toHaveBeenCalledWith('admin');
    });
  });

  describe('!release-notes command', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
    });

    test('shows release notes when available', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!release-notes',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
      // The post should contain version info (either formatted release notes or fallback message)
      const postContent = (client.createPost as any).mock.calls[0][0];
      // Either contains "Release Notes" (formatted) or "claude-threads" (fallback)
      expect(postContent.includes('Release Notes') || postContent.includes('claude-threads')).toBe(true);
    });

    test('handles !changelog alias', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!changelog',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
    });
  });

  describe('pending worktree prompt', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
      (session.hasPendingWorktreePrompt as any).mockReturnValue(true);
    });

    test('handles branch response when user is allowed', async () => {
      (session.handleWorktreeBranchResponse as any).mockResolvedValue(true);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'feature/my-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.handleWorktreeBranchResponse).toHaveBeenCalledWith(
        'thread1',
        'feature/my-branch',
        'allowed-user',
        'post1'
      );
      expect(session.sendFollowUp).not.toHaveBeenCalled();
    });

    test('falls through when branch response returns false', async () => {
      (session.handleWorktreeBranchResponse as any).mockResolvedValue(false);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'not a valid branch response',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.handleWorktreeBranchResponse).toHaveBeenCalled();
      // Should fall through to sendFollowUp
      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', 'not a valid branch response', undefined, 'allowed-user', 'User');
    });

    test('does not handle branch response for unauthorized user', async () => {
      (session.isUserAllowedInSession as any).mockReturnValue(false);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'feature/branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect(session.handleWorktreeBranchResponse).not.toHaveBeenCalled();
      expect(session.requestMessageApproval).toHaveBeenCalled();
    });
  });
});
