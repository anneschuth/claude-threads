import { describe, it, expect, mock } from 'bun:test';
import {
  deliverLifecycleNotice,
  updateLifecycleNotice,
  LIFECYCLE_REACTION_EMOJI,
} from './lifecycle-delivery.js';
import { updateLastMessage } from '../operations/post-helpers/index.js';
import { RESUME_EMOJIS, CANCEL_EMOJIS, ESCAPE_EMOJIS, APPROVAL_EMOJIS, DENIAL_EMOJIS, ALLOW_ALL_EMOJIS, NUMBER_EMOJIS, BUG_REPORT_EMOJI } from '../utils/emoji.js';
import type { Session } from './types.js';
import type { PlatformPost } from '../platform/index.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'p:thread-1',
    threadId: 'thread-1',
    platform: {
      platformType: 'mattermost',
      addReaction: mock(() => Promise.resolve()),
      removeReaction: mock(() => Promise.resolve()),
    },
    ...overrides,
  } as unknown as Session;
}

function newPost(id: string) {
  return mock(() => Promise.resolve({ id } as PlatformPost));
}

function refreshOk() {
  return mock((_postId: string) => Promise.resolve());
}

describe('deliverLifecycleNotice', () => {
  describe('post', () => {
    it('creates the post and tracks nothing, exactly as before', async () => {
      const session = makeSession({ lastMessageId: 'reply-1' });
      const create = newPost('notice-1');

      const anchor = await deliverLifecycleNotice(session, 'post', 'timed-out', create, refreshOk());

      expect(anchor?.id).toBe('notice-1');
      expect(create).toHaveBeenCalledTimes(1);
      expect(session.platform.addReaction).not.toHaveBeenCalled();
      // Nothing new in sessions.json for the default.
      expect(session.lifecycleNotice).toBeUndefined();
    });

    it('creates even when the thread already ends in the same notice', async () => {
      const session = makeSession({
        lifecycleNotice: { postId: 'old', kind: 'timed-out', reaction: false, trailing: true },
      });
      const create = newPost('notice-2');

      await deliverLifecycleNotice(session, 'post', 'timed-out', create, refreshOk());

      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  describe('dedup', () => {
    it('refreshes the bot\'s last post in place when it is the same notice, and anchors on it', async () => {
      const session = makeSession({
        lifecycleNotice: { postId: 'notice-1', kind: 'paused', reaction: false, trailing: true },
      });
      const create = newPost('notice-2');
      const refresh = refreshOk();

      const anchor = await deliverLifecycleNotice(session, 'dedup', 'paused', create, refresh);

      expect(create).not.toHaveBeenCalled();
      // An edit, so the text is current and nobody is notified.
      expect(refresh).toHaveBeenCalledWith('notice-1');
      // The caller stores this as lifecyclePostId, so 🔄 on it resumes.
      expect(anchor?.id).toBe('notice-1');
    });

    it('posts when the refresh fails (the old notice was deleted)', async () => {
      const session = makeSession({
        lifecycleNotice: { postId: 'gone', kind: 'paused', reaction: false, trailing: true },
      });
      const create = newPost('notice-2');

      const anchor = await deliverLifecycleNotice(session, 'dedup', 'paused', create, mock(() => Promise.reject(new Error('404'))));

      expect(create).toHaveBeenCalledTimes(1);
      expect(anchor?.id).toBe('notice-2');
    });

    it('does not refresh a notice carried as a reaction: that text is someone else\'s', async () => {
      const session = makeSession({
        lifecycleNotice: { postId: 'reply-1', kind: 'paused', reaction: true, trailing: true },
      });
      const create = newPost('notice-2');
      const refresh = refreshOk();

      await deliverLifecycleNotice(session, 'dedup', 'paused', create, refresh);

      expect(refresh).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('posts once the bot has posted anything after the notice', async () => {
      const session = makeSession();
      await deliverLifecycleNotice(session, 'dedup', 'paused', newPost('notice-1'), refreshOk());
      // Claude replies after the session resumed: the notice no longer ends the thread.
      updateLastMessage(session, { id: 'reply-1' } as PlatformPost);
      const create = newPost('notice-2');

      const anchor = await deliverLifecycleNotice(session, 'dedup', 'paused', create, refreshOk());

      expect(create).toHaveBeenCalledTimes(1);
      expect(anchor?.id).toBe('notice-2');
      expect(session.lifecycleNotice).toEqual({ postId: 'notice-2', kind: 'paused', reaction: false, trailing: true });
    });

    it('posts a different notice', async () => {
      const session = makeSession({
        lifecycleNotice: { postId: 'notice-1', kind: 'idle-warning', reaction: false, trailing: true },
      });
      const create = newPost('notice-2');

      await deliverLifecycleNotice(session, 'dedup', 'paused', create, refreshOk());

      expect(create).toHaveBeenCalledTimes(1);
    });

    // Back to back restarts: the first shutdown post was rewritten into
    // "Session resumed" on the way back, and that is what the thread shows
    // when the next restart's shutdown notice comes.
    it('treats a resume notice as the shutdown notice a restart would post', async () => {
      const session = makeSession({
        lifecycleNotice: { postId: 'notice-1', kind: 'resumed', reaction: false, trailing: true },
      });
      const create = newPost('notice-2');
      const refresh = refreshOk();

      const anchor = await deliverLifecycleNotice(session, 'dedup', 'shutdown', create, refresh);

      expect(create).not.toHaveBeenCalled();
      // It reads "Bot shutting down" again, not a stale "Session resumed".
      expect(refresh).toHaveBeenCalledWith('notice-1');
      expect(anchor?.id).toBe('notice-1');
      expect(session.lifecycleNotice?.kind).toBe('shutdown');
    });
  });

  describe('reaction', () => {
    it('reacts to the bot\'s last post instead of creating one', async () => {
      const session = makeSession({ lastMessageId: 'reply-1' });
      const create = newPost('notice-1');

      const anchor = await deliverLifecycleNotice(session, 'reaction', 'idle-warning', create, refreshOk());

      expect(create).not.toHaveBeenCalled();
      expect(session.platform.addReaction).toHaveBeenCalledWith('reply-1', 'hourglass_flowing_sand');
      // The reacted-to post is the anchor 🔄 resumes from.
      expect(anchor?.id).toBe('reply-1');
      expect(session.lifecycleNotice).toEqual({ postId: 'reply-1', kind: 'idle-warning', reaction: true, trailing: true });
    });

    it('does not mark the post trailing when a reply lands while the reaction is in flight', async () => {
      const session = makeSession({ lastMessageId: 'reply-1' });
      (session.platform.addReaction as ReturnType<typeof mock>).mockImplementation(async () => {
        updateLastMessage(session, { id: 'reply-2' } as PlatformPost);
      });

      await deliverLifecycleNotice(session, 'reaction', 'idle-warning', newPost('x'), refreshOk());

      expect(session.lifecycleNotice?.trailing).toBe(false);
    });

    it('swaps its own previous emoji rather than stacking them', async () => {
      const session = makeSession({
        lastMessageId: 'reply-1',
        lifecycleNotice: { postId: 'reply-1', kind: 'resumed', reaction: true, trailing: true },
      });

      await deliverLifecycleNotice(session, 'reaction', 'shutdown', newPost('x'), refreshOk());

      expect(session.platform.addReaction).toHaveBeenCalledWith('reply-1', 'electric_plug');
      expect(session.platform.removeReaction).toHaveBeenCalledWith('reply-1', 'sunrise');
    });

    // After a restart nothing is known about the thread until the bot posts.
    it('posts when there is no bot post to react to', async () => {
      const session = makeSession();
      const create = newPost('notice-1');

      const anchor = await deliverLifecycleNotice(session, 'reaction', 'resumed', create, refreshOk());

      expect(create).toHaveBeenCalledTimes(1);
      expect(anchor?.id).toBe('notice-1');
    });

    it('posts when the reaction fails, so the notice is not lost', async () => {
      const session = makeSession({ lastMessageId: 'deleted-post' });
      (session.platform.addReaction as ReturnType<typeof mock>).mockImplementation(() => Promise.reject(new Error('not found')));
      const create = newPost('notice-1');

      const anchor = await deliverLifecycleNotice(session, 'reaction', 'timed-out', create, refreshOk());

      expect(create).toHaveBeenCalledTimes(1);
      expect(anchor?.id).toBe('notice-1');
    });
  });

  it('returns null when the create fails', async () => {
    const session = makeSession();
    const anchor = await deliverLifecycleNotice(session, 'dedup', 'paused', mock(() => Promise.resolve(undefined)), refreshOk());
    expect(anchor).toBeNull();
    expect(session.lifecycleNotice).toBeUndefined();
  });
});

describe('updateLifecycleNotice', () => {
  it('edits a notice post in place', async () => {
    const session = makeSession({
      lifecyclePostId: 'notice-1',
      lifecycleNotice: { postId: 'notice-1', kind: 'idle-warning', reaction: false, trailing: true },
    });
    const edit = mock(() => Promise.resolve());

    await updateLifecycleNotice(session, 'timed-out', edit);

    expect(edit).toHaveBeenCalledTimes(1);
    expect(session.lifecycleNotice?.kind).toBe('timed-out');
  });

  it('just edits when nothing is tracked (lifecycleDelivery: post)', async () => {
    const session = makeSession({ lifecyclePostId: 'notice-1' });
    const edit = mock(() => Promise.resolve());

    await updateLifecycleNotice(session, 'resumed', edit);

    expect(edit).toHaveBeenCalledTimes(1);
    expect(session.platform.addReaction).not.toHaveBeenCalled();
  });

  // The anchor of a reaction is usually Claude's reply. Editing it would
  // overwrite the answer with "Session timed out".
  it('never rewrites a post that carries the notice as a reaction', async () => {
    const session = makeSession({
      lifecyclePostId: 'reply-1',
      lifecycleNotice: { postId: 'reply-1', kind: 'idle-warning', reaction: true, trailing: true },
    });
    const edit = mock(() => Promise.resolve());

    await updateLifecycleNotice(session, 'timed-out', edit);

    expect(edit).not.toHaveBeenCalled();
    expect(session.platform.addReaction).toHaveBeenCalledWith('reply-1', 'alarm_clock');
    expect(session.platform.removeReaction).toHaveBeenCalledWith('reply-1', 'hourglass_flowing_sand');
    expect(session.lifecycleNotice?.kind).toBe('timed-out');
  });

  it('keeps tracking the emoji that is actually up when the swap fails', async () => {
    const session = makeSession({
      lifecyclePostId: 'reply-1',
      lifecycleNotice: { postId: 'reply-1', kind: 'idle-warning', reaction: true, trailing: true },
    });
    (session.platform.addReaction as ReturnType<typeof mock>).mockImplementation(() => Promise.reject(new Error('rate limited')));

    await updateLifecycleNotice(session, 'timed-out', mock(() => Promise.resolve()));

    expect(session.platform.removeReaction).not.toHaveBeenCalled();
    expect(session.lifecycleNotice?.kind).toBe('idle-warning');
  });

  it('does not re-add an emoji that is already up', async () => {
    const session = makeSession({
      lifecycleNotice: { postId: 'reply-1', kind: 'paused', reaction: true, trailing: true },
    });
    const create = newPost('x');

    const anchor = await deliverLifecycleNotice(session, 'reaction', 'paused', create, refreshOk());

    expect(session.platform.addReaction).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(anchor?.id).toBe('reply-1');
  });

  it('still edits when the reaction notice is on another post than the anchor', async () => {
    const session = makeSession({
      lifecyclePostId: 'notice-9',
      lifecycleNotice: { postId: 'reply-1', kind: 'idle-warning', reaction: true, trailing: false },
    });
    const edit = mock(() => Promise.resolve());

    await updateLifecycleNotice(session, 'timed-out', edit);

    expect(edit).toHaveBeenCalledTimes(1);
  });
});

describe('LIFECYCLE_REACTION_EMOJI', () => {
  // The bot's own reaction must not be a control a user could click into an
  // action (or that the router could read as one).
  it('uses no reaction-control emoji', () => {
    const controls = new Set<string>([
      ...RESUME_EMOJIS, ...CANCEL_EMOJIS, ...ESCAPE_EMOJIS, ...APPROVAL_EMOJIS,
      ...DENIAL_EMOJIS, ...ALLOW_ALL_EMOJIS, ...NUMBER_EMOJIS, BUG_REPORT_EMOJI,
    ]);
    for (const emoji of Object.values(LIFECYCLE_REACTION_EMOJI)) {
      expect(controls.has(emoji)).toBe(false);
    }
  });
});
