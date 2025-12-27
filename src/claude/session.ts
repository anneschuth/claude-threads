import { ClaudeCli, ClaudeEvent, ClaudeCliOptions } from './cli.js';
import { MattermostClient } from '../mattermost/client.js';

// =============================================================================
// Interfaces
// =============================================================================

interface QuestionOption {
  label: string;
  description: string;
}

interface PendingQuestionSet {
  toolUseId: string;
  currentIndex: number;
  currentPostId: string | null;
  questions: Array<{
    header: string;
    question: string;
    options: QuestionOption[];
    answer: string | null;
  }>;
}

interface PendingApproval {
  postId: string;
  type: 'plan' | 'action';
}

/**
 * Represents a single Claude Code session tied to a Mattermost thread.
 * Each session has its own Claude CLI process and state.
 */
interface Session {
  // Identity
  threadId: string;
  startedBy: string;
  startedAt: Date;
  lastActivityAt: Date;

  // Claude process
  claude: ClaudeCli;

  // Post state for streaming updates
  currentPostId: string | null;
  pendingContent: string;

  // Interactive state
  pendingApproval: PendingApproval | null;
  pendingQuestionSet: PendingQuestionSet | null;
  planApproved: boolean;

  // Display state
  tasksPostId: string | null;
  activeSubagents: Map<string, string>;  // toolUseId -> postId

  // Timers (per-session)
  updateTimer: ReturnType<typeof setTimeout> | null;
  typingTimer: ReturnType<typeof setInterval> | null;
}

const REACTION_EMOJIS = ['one', 'two', 'three', 'four'];
const EMOJI_TO_INDEX: Record<string, number> = {
  'one': 0, '1️⃣': 0,
  'two': 1, '2️⃣': 1,
  'three': 2, '3️⃣': 2,
  'four': 3, '4️⃣': 3,
};

// =============================================================================
// Configuration
// =============================================================================

const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '5', 10);
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || '1800000', 10); // 30 min

// =============================================================================
// SessionManager - Manages multiple concurrent Claude Code sessions
// =============================================================================

export class SessionManager {
  // Shared state
  private mattermost: MattermostClient;
  private workingDir: string;
  private skipPermissions: boolean;
  private debug = process.env.DEBUG === '1' || process.argv.includes('--debug');

  // Multi-session storage
  private sessions: Map<string, Session> = new Map();  // threadId -> Session
  private postIndex: Map<string, string> = new Map();  // postId -> threadId (for reaction routing)

  // Cleanup timer
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(mattermost: MattermostClient, workingDir: string, skipPermissions = false) {
    this.mattermost = mattermost;
    this.workingDir = workingDir;
    this.skipPermissions = skipPermissions;

    // Listen for reactions to answer questions
    this.mattermost.on('reaction', (reaction, user) => {
      this.handleReaction(reaction.post_id, reaction.emoji_name, user?.username || 'unknown');
    });

    // Start periodic cleanup of idle sessions
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 60000);
  }

  // ---------------------------------------------------------------------------
  // Session Lookup Methods
  // ---------------------------------------------------------------------------

  /** Get a session by thread ID */
  getSession(threadId: string): Session | undefined {
    return this.sessions.get(threadId);
  }

  /** Check if a session exists for this thread */
  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  /** Get the number of active sessions */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /** Register a post for reaction routing */
  private registerPost(postId: string, threadId: string): void {
    this.postIndex.set(postId, threadId);
  }

  /** Find session by post ID (for reaction routing) */
  private getSessionByPost(postId: string): Session | undefined {
    const threadId = this.postIndex.get(postId);
    return threadId ? this.sessions.get(threadId) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Session Lifecycle
  // ---------------------------------------------------------------------------

  async startSession(
    options: { prompt: string },
    username: string,
    replyToPostId?: string
  ): Promise<void> {
    const threadId = replyToPostId || '';

    // Check if session already exists for this thread
    const existingSession = this.sessions.get(threadId);
    if (existingSession && existingSession.claude.isRunning()) {
      // Send as follow-up instead
      await this.sendFollowUp(threadId, options.prompt);
      return;
    }

    // Check max sessions limit
    if (this.sessions.size >= MAX_SESSIONS) {
      await this.mattermost.createPost(
        `⚠️ **Too busy** - ${this.sessions.size} sessions active. Please try again later.`,
        replyToPostId
      );
      return;
    }

    // Post session start message
    const msg = `🚀 **Session started**\n> Working directory: \`${this.workingDir}\``;
    const post = await this.mattermost.createPost(msg, replyToPostId);
    const actualThreadId = replyToPostId || post.id;

    // Create Claude CLI with options
    const cliOptions: ClaudeCliOptions = {
      workingDir: this.workingDir,
      threadId: actualThreadId,
      skipPermissions: this.skipPermissions,
    };
    const claude = new ClaudeCli(cliOptions);

    // Create the session object
    const session: Session = {
      threadId: actualThreadId,
      startedBy: username,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      claude,
      currentPostId: null,
      pendingContent: '',
      pendingApproval: null,
      pendingQuestionSet: null,
      planApproved: false,
      tasksPostId: null,
      activeSubagents: new Map(),
      updateTimer: null,
      typingTimer: null,
    };

    // Register session
    this.sessions.set(actualThreadId, session);
    console.log(`[Sessions] Started session for thread ${actualThreadId} by ${username} (active: ${this.sessions.size})`);

    // Bind event handlers with closure over threadId
    claude.on('event', (e: ClaudeEvent) => this.handleEvent(actualThreadId, e));
    claude.on('exit', (code: number) => this.handleExit(actualThreadId, code));

    try {
      claude.start();
    } catch (err) {
      console.error('[Session] Start error:', err);
      await this.mattermost.createPost(`❌ ${err}`, actualThreadId);
      this.sessions.delete(actualThreadId);
      return;
    }

    // Send the message and start typing indicator
    claude.sendMessage(options.prompt);
    this.startTyping(session);
  }

  private handleEvent(threadId: string, event: ClaudeEvent): void {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Update last activity
    session.lastActivityAt = new Date();

    // Check for special tool uses that need custom handling
    if (event.type === 'assistant') {
      const msg = event.message as { content?: Array<{ type: string; name?: string; id?: string; input?: Record<string, unknown> }> };
      let hasSpecialTool = false;
      for (const block of msg?.content || []) {
        if (block.type === 'tool_use') {
          if (block.name === 'ExitPlanMode') {
            this.handleExitPlanMode(session);
            hasSpecialTool = true;
          } else if (block.name === 'TodoWrite') {
            this.handleTodoWrite(session, block.input as Record<string, unknown>);
          } else if (block.name === 'Task') {
            this.handleTaskStart(session, block.id as string, block.input as Record<string, unknown>);
          } else if (block.name === 'AskUserQuestion') {
            this.handleAskUserQuestion(session, block.id as string, block.input as Record<string, unknown>);
            hasSpecialTool = true;
          }
        }
      }
      if (hasSpecialTool) return;
    }

    // Check for tool_result to update subagent status
    if (event.type === 'user') {
      const msg = event.message as { content?: Array<{ type: string; tool_use_id?: string; content?: string }> };
      for (const block of msg?.content || []) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const postId = session.activeSubagents.get(block.tool_use_id);
          if (postId) {
            this.handleTaskComplete(session, block.tool_use_id, postId);
          }
        }
      }
    }

    const formatted = this.formatEvent(session, event);
    if (this.debug) {
      console.log(`[DEBUG] handleEvent(${threadId}): ${event.type} -> ${formatted ? formatted.substring(0, 100) : '(null)'}`);
    }
    if (formatted) this.appendContent(session, formatted);
  }

  private async handleTaskComplete(session: Session, toolUseId: string, postId: string): Promise<void> {
    try {
      await this.mattermost.updatePost(postId,
        session.activeSubagents.has(toolUseId)
          ? `🤖 **Subagent** ✅ *completed*`
          : `🤖 **Subagent** ✅`
      );
      session.activeSubagents.delete(toolUseId);
    } catch (err) {
      console.error('[Session] Failed to update subagent completion:', err);
    }
  }

  private async handleExitPlanMode(session: Session): Promise<void> {
    // If already approved in this session, auto-continue
    if (session.planApproved) {
      console.log('[Session] Plan already approved, auto-continuing...');
      if (session.claude.isRunning()) {
        session.claude.sendMessage('Continue with the implementation.');
        this.startTyping(session);
      }
      return;
    }

    // If we already have a pending approval, don't post another one
    if (session.pendingApproval && session.pendingApproval.type === 'plan') {
      console.log('[Session] Plan approval already pending, waiting...');
      return;
    }

    // Flush any pending content first
    await this.flush(session);
    session.currentPostId = null;
    session.pendingContent = '';

    // Post approval message with reactions
    const message = `✅ **Plan ready for approval**\n\n` +
      `👍 Approve and start building\n` +
      `👎 Request changes\n\n` +
      `*React to respond*`;

    const post = await this.mattermost.createPost(message, session.threadId);

    // Register post for reaction routing
    this.registerPost(post.id, session.threadId);

    // Add approval reactions
    try {
      await this.mattermost.addReaction(post.id, '+1');
      await this.mattermost.addReaction(post.id, '-1');
    } catch (err) {
      console.error('[Session] Failed to add approval reactions:', err);
    }

    // Track this for reaction handling
    session.pendingApproval = { postId: post.id, type: 'plan' };

    // Stop typing while waiting
    this.stopTyping(session);
  }

  private async handleTodoWrite(session: Session, input: Record<string, unknown>): Promise<void> {
    const todos = input.todos as Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm: string;
    }>;

    if (!todos || todos.length === 0) {
      // Clear tasks display if empty
      if (session.tasksPostId) {
        try {
          await this.mattermost.updatePost(session.tasksPostId, '📋 ~~Tasks~~ *(completed)*');
        } catch (err) {
          console.error('[Session] Failed to update tasks:', err);
        }
      }
      return;
    }

    // Format tasks nicely
    let message = '📋 **Tasks**\n\n';
    for (const todo of todos) {
      let icon: string;
      let text: string;
      switch (todo.status) {
        case 'completed':
          icon = '✅';
          text = `~~${todo.content}~~`;
          break;
        case 'in_progress':
          icon = '🔄';
          text = `**${todo.activeForm}**`;
          break;
        default: // pending
          icon = '⬜';
          text = todo.content;
      }
      message += `${icon} ${text}\n`;
    }

    // Update or create tasks post
    try {
      if (session.tasksPostId) {
        await this.mattermost.updatePost(session.tasksPostId, message);
      } else {
        const post = await this.mattermost.createPost(message, session.threadId);
        session.tasksPostId = post.id;
      }
    } catch (err) {
      console.error('[Session] Failed to update tasks:', err);
    }
  }

  private async handleTaskStart(session: Session, toolUseId: string, input: Record<string, unknown>): Promise<void> {
    const description = input.description as string || 'Working...';
    const subagentType = input.subagent_type as string || 'general';

    // Post subagent status
    const message = `🤖 **Subagent** *(${subagentType})*\n` +
      `> ${description}\n` +
      `⏳ Running...`;

    try {
      const post = await this.mattermost.createPost(message, session.threadId);
      session.activeSubagents.set(toolUseId, post.id);
    } catch (err) {
      console.error('[Session] Failed to post subagent status:', err);
    }
  }

  private async handleAskUserQuestion(session: Session, toolUseId: string, input: Record<string, unknown>): Promise<void> {
    // If we already have pending questions, don't start another set
    if (session.pendingQuestionSet) {
      console.log('[Session] Questions already pending, waiting...');
      return;
    }

    // Flush any pending content first
    await this.flush(session);
    session.currentPostId = null;
    session.pendingContent = '';

    const questions = input.questions as Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>;

    if (!questions || questions.length === 0) return;

    // Create a new question set - we'll ask one at a time
    session.pendingQuestionSet = {
      toolUseId,
      currentIndex: 0,
      currentPostId: null,
      questions: questions.map(q => ({
        header: q.header,
        question: q.question,
        options: q.options,
        answer: null,
      })),
    };

    // Post the first question
    await this.postCurrentQuestion(session);

    // Stop typing while waiting for answer
    this.stopTyping(session);
  }

  private async postCurrentQuestion(session: Session): Promise<void> {
    if (!session.pendingQuestionSet) return;

    const { currentIndex, questions } = session.pendingQuestionSet;
    if (currentIndex >= questions.length) return;

    const q = questions[currentIndex];
    const total = questions.length;

    // Format the question message
    let message = `❓ **Question** *(${currentIndex + 1}/${total})*\n`;
    message += `**${q.header}:** ${q.question}\n\n`;
    for (let i = 0; i < q.options.length && i < 4; i++) {
      const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i];
      message += `${emoji} **${q.options[i].label}**`;
      if (q.options[i].description) {
        message += ` - ${q.options[i].description}`;
      }
      message += '\n';
    }

    // Post the question
    const post = await this.mattermost.createPost(message, session.threadId);
    session.pendingQuestionSet.currentPostId = post.id;

    // Register post for reaction routing
    this.registerPost(post.id, session.threadId);

    // Add reaction emojis
    for (let i = 0; i < q.options.length && i < 4; i++) {
      try {
        await this.mattermost.addReaction(post.id, REACTION_EMOJIS[i]);
      } catch (err) {
        console.error(`[Session] Failed to add reaction ${REACTION_EMOJIS[i]}:`, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Reaction Handling
  // ---------------------------------------------------------------------------

  private async handleReaction(postId: string, emojiName: string, username: string): Promise<void> {
    // Check if user is allowed
    if (!this.mattermost.isUserAllowed(username)) return;

    // Find the session this post belongs to
    const session = this.getSessionByPost(postId);
    if (!session) return;

    // Handle approval reactions
    if (session.pendingApproval && session.pendingApproval.postId === postId) {
      await this.handleApprovalReaction(session, emojiName, username);
      return;
    }

    // Handle question reactions
    if (session.pendingQuestionSet && session.pendingQuestionSet.currentPostId === postId) {
      await this.handleQuestionReaction(session, postId, emojiName, username);
      return;
    }
  }

  private async handleQuestionReaction(session: Session, postId: string, emojiName: string, username: string): Promise<void> {
    if (!session.pendingQuestionSet) return;

    const { currentIndex, questions } = session.pendingQuestionSet;
    const question = questions[currentIndex];
    if (!question) return;

    const optionIndex = EMOJI_TO_INDEX[emojiName];
    if (optionIndex === undefined || optionIndex >= question.options.length) return;

    const selectedOption = question.options[optionIndex];
    question.answer = selectedOption.label;
    console.log(`[Session] User ${username} answered "${question.header}": ${selectedOption.label}`);

    // Update the post to show answer
    try {
      await this.mattermost.updatePost(postId, `✅ **${question.header}**: ${selectedOption.label}`);
    } catch (err) {
      console.error('[Session] Failed to update answered question:', err);
    }

    // Move to next question or finish
    session.pendingQuestionSet.currentIndex++;

    if (session.pendingQuestionSet.currentIndex < questions.length) {
      // Post next question
      await this.postCurrentQuestion(session);
    } else {
      // All questions answered - send as follow-up message
      let answersText = 'Here are my answers:\n';
      for (const q of questions) {
        answersText += `- **${q.header}**: ${q.answer}\n`;
      }

      console.log(`[Session] All questions answered, sending as message:`, answersText);

      // Clear and send as regular message
      session.pendingQuestionSet = null;

      if (session.claude.isRunning()) {
        session.claude.sendMessage(answersText);
        this.startTyping(session);
      }
    }
  }

  private async handleApprovalReaction(session: Session, emojiName: string, username: string): Promise<void> {
    if (!session.pendingApproval) return;

    const isApprove = emojiName === '+1' || emojiName === 'thumbsup';
    const isReject = emojiName === '-1' || emojiName === 'thumbsdown';

    if (!isApprove && !isReject) return;

    const postId = session.pendingApproval.postId;
    console.log(`[Session] User ${username} ${isApprove ? 'approved' : 'rejected'} the plan`);

    // Update the post to show the decision
    try {
      const statusMessage = isApprove
        ? `✅ **Plan approved** by @${username} - starting implementation...`
        : `❌ **Changes requested** by @${username}`;
      await this.mattermost.updatePost(postId, statusMessage);
    } catch (err) {
      console.error('[Session] Failed to update approval post:', err);
    }

    // Clear pending approval and mark as approved
    session.pendingApproval = null;
    if (isApprove) {
      session.planApproved = true;
    }

    // Send response to Claude
    if (session.claude.isRunning()) {
      const response = isApprove
        ? 'Approved. Please proceed with the implementation.'
        : 'Please revise the plan. I would like some changes.';
      session.claude.sendMessage(response);
      this.startTyping(session);
    }
  }

  private formatEvent(session: Session, e: ClaudeEvent): string | null {
    switch (e.type) {
      case 'assistant': {
        const msg = e.message as { content?: Array<{ type: string; text?: string; thinking?: string; name?: string; input?: Record<string, unknown> }> };
        const parts: string[] = [];
        for (const block of msg?.content || []) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'tool_use' && block.name) {
            const formatted = this.formatToolUse(block.name, block.input || {});
            if (formatted) parts.push(formatted);
          } else if (block.type === 'thinking' && block.thinking) {
            // Extended thinking - show abbreviated version
            const thinking = block.thinking as string;
            const preview = thinking.length > 100 ? thinking.substring(0, 100) + '...' : thinking;
            parts.push(`💭 *Thinking: ${preview}*`);
          } else if (block.type === 'server_tool_use' && block.name) {
            // Server-managed tools like web search
            parts.push(`🌐 **${block.name}** ${block.input ? JSON.stringify(block.input).substring(0, 50) : ''}`);
          }
        }
        return parts.length > 0 ? parts.join('\n') : null;
      }
      case 'tool_use': {
        const tool = e.tool_use as { name: string; input?: Record<string, unknown> };
        return this.formatToolUse(tool.name, tool.input || {}) || null;
      }
      case 'tool_result': {
        const result = e.tool_result as { is_error?: boolean };
        if (result.is_error) return `  ↳ ❌ Error`;
        return null;
      }
      case 'result': {
        // Response complete - stop typing and start new post for next message
        this.stopTyping(session);
        this.flush(session);
        session.currentPostId = null;
        session.pendingContent = '';
        return null;
      }
      case 'system':
        if (e.subtype === 'error') return `❌ ${e.error}`;
        return null;
      default:
        return null;
    }
  }

  private formatToolUse(name: string, input: Record<string, unknown>): string | null {
    const short = (p: string) => {
      const home = process.env.HOME || '';
      return p?.startsWith(home) ? '~' + p.slice(home.length) : p;
    };
    switch (name) {
      case 'Read': return `📄 **Read** \`${short(input.file_path as string)}\``;
      case 'Edit': {
        const filePath = short(input.file_path as string);
        const oldStr = (input.old_string as string || '').trim();
        const newStr = (input.new_string as string || '').trim();

        // Show diff if we have old/new strings
        if (oldStr || newStr) {
          const maxLines = 8;
          const oldLines = oldStr.split('\n').slice(0, maxLines);
          const newLines = newStr.split('\n').slice(0, maxLines);

          let diff = `✏️ **Edit** \`${filePath}\`\n\`\`\`diff\n`;
          for (const line of oldLines) {
            diff += `- ${line}\n`;
          }
          if (oldStr.split('\n').length > maxLines) diff += `- ... (${oldStr.split('\n').length - maxLines} more lines)\n`;
          for (const line of newLines) {
            diff += `+ ${line}\n`;
          }
          if (newStr.split('\n').length > maxLines) diff += `+ ... (${newStr.split('\n').length - maxLines} more lines)\n`;
          diff += '```';
          return diff;
        }
        return `✏️ **Edit** \`${filePath}\``;
      }
      case 'Write': {
        const filePath = short(input.file_path as string);
        const content = input.content as string || '';
        const lines = content.split('\n');
        const lineCount = lines.length;

        // Show preview of content
        if (content && lineCount > 0) {
          const maxLines = 6;
          const previewLines = lines.slice(0, maxLines);
          let preview = `📝 **Write** \`${filePath}\` *(${lineCount} lines)*\n\`\`\`\n`;
          preview += previewLines.join('\n');
          if (lineCount > maxLines) preview += `\n... (${lineCount - maxLines} more lines)`;
          preview += '\n```';
          return preview;
        }
        return `📝 **Write** \`${filePath}\``;
      }
      case 'Bash': {
        const cmd = (input.command as string || '').substring(0, 50);
        return `💻 **Bash** \`${cmd}${cmd.length >= 50 ? '...' : ''}\``;
      }
      case 'Glob': return `🔍 **Glob** \`${input.pattern}\``;
      case 'Grep': return `🔎 **Grep** \`${input.pattern}\``;
      case 'Task': return null; // Handled specially with subagent display
      case 'EnterPlanMode': return `📋 **Planning...**`;
      case 'ExitPlanMode': return null; // Handled specially with approval buttons
      case 'AskUserQuestion': return null; // Don't show, the question text follows
      case 'TodoWrite': return null; // Handled specially with task list display
      case 'WebFetch': return `🌐 **Fetching** \`${(input.url as string || '').substring(0, 40)}\``;
      case 'WebSearch': return `🔍 **Searching** \`${input.query}\``;
      default: {
        // Handle MCP tools: mcp__server__tool -> 🔌 tool (server)
        if (name.startsWith('mcp__')) {
          const parts = name.split('__');
          if (parts.length >= 3) {
            const server = parts[1];
            const tool = parts.slice(2).join('__');
            return `🔌 **${tool}** *(${server})*`;
          }
        }
        return `● **${name}**`;
      }
    }
  }

  private appendContent(session: Session, text: string): void {
    if (!text) return;
    session.pendingContent += text + '\n';
    this.scheduleUpdate(session);
  }

  private scheduleUpdate(session: Session): void {
    if (session.updateTimer) return;
    session.updateTimer = setTimeout(() => {
      session.updateTimer = null;
      this.flush(session);
    }, 500);
  }

  private startTyping(session: Session): void {
    if (session.typingTimer) return;
    // Send typing immediately, then every 3 seconds
    this.mattermost.sendTyping(session.threadId);
    session.typingTimer = setInterval(() => {
      this.mattermost.sendTyping(session.threadId);
    }, 3000);
  }

  private stopTyping(session: Session): void {
    if (session.typingTimer) {
      clearInterval(session.typingTimer);
      session.typingTimer = null;
    }
  }

  private async flush(session: Session): Promise<void> {
    if (!session.pendingContent.trim()) return;

    const content = session.pendingContent.replace(/\n{3,}/g, '\n\n').trim();

    if (session.currentPostId) {
      await this.mattermost.updatePost(session.currentPostId, content);
    } else {
      const post = await this.mattermost.createPost(content, session.threadId);
      session.currentPostId = post.id;
      // Register post for reaction routing
      this.registerPost(post.id, session.threadId);
    }
  }

  private async handleExit(threadId: string, code: number): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    this.stopTyping(session);
    if (session.updateTimer) {
      clearTimeout(session.updateTimer);
      session.updateTimer = null;
    }
    await this.flush(session);

    if (code !== 0) {
      await this.mattermost.createPost(`**[Exited: ${code}]**`, session.threadId);
    }

    // Clean up session from maps
    this.sessions.delete(threadId);
    // Clean up post index entries for this session
    for (const [postId, tid] of this.postIndex.entries()) {
      if (tid === threadId) {
        this.postIndex.delete(postId);
      }
    }
    console.log(`[Sessions] Session ended for thread ${threadId} (remaining: ${this.sessions.size})`);
  }

  // ---------------------------------------------------------------------------
  // Public Session API
  // ---------------------------------------------------------------------------

  /** Check if any sessions are active */
  isSessionActive(): boolean {
    return this.sessions.size > 0;
  }

  /** Check if a session exists for this thread */
  isInSessionThread(threadRoot: string): boolean {
    const session = this.sessions.get(threadRoot);
    return session !== undefined && session.claude.isRunning();
  }

  /** Send a follow-up message to an existing session */
  async sendFollowUp(threadId: string, message: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session || !session.claude.isRunning()) return;
    session.claude.sendMessage(message);
    session.lastActivityAt = new Date();
    this.startTyping(session);
  }

  /** Kill a specific session */
  killSession(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;

    this.stopTyping(session);
    session.claude.kill();

    // Clean up session from maps
    this.sessions.delete(threadId);
    for (const [postId, tid] of this.postIndex.entries()) {
      if (tid === threadId) {
        this.postIndex.delete(postId);
      }
    }
    console.log(`[Sessions] Session killed for thread ${threadId} (remaining: ${this.sessions.size})`);
  }

  /** Kill all active sessions (for graceful shutdown) */
  killAllSessions(): void {
    for (const [threadId, session] of this.sessions.entries()) {
      this.stopTyping(session);
      session.claude.kill();
      console.log(`[Sessions] Killed session for thread ${threadId}`);
    }
    this.sessions.clear();
    this.postIndex.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    console.log(`[Sessions] All sessions killed`);
  }

  /** Cleanup idle sessions that have exceeded timeout */
  private cleanupIdleSessions(): void {
    const now = Date.now();
    for (const [threadId, session] of this.sessions.entries()) {
      const idleTime = now - session.lastActivityAt.getTime();
      if (idleTime > SESSION_TIMEOUT_MS) {
        console.log(`[Sessions] Session ${threadId} timed out after ${Math.round(idleTime / 60000)} minutes`);
        this.mattermost.createPost(
          `⏰ **Session timed out** - no activity for ${Math.round(idleTime / 60000)} minutes`,
          session.threadId
        ).catch(err => console.error('[Sessions] Failed to post timeout message:', err));
        this.killSession(threadId);
      }
    }
  }
}
