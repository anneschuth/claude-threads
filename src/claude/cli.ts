import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface ClaudeEvent {
  type: string;
  [key: string]: unknown;
}

export class ClaudeCli extends EventEmitter {
  private process: ChildProcess | null = null;
  private workingDir: string;
  private buffer = '';
  public debug = process.env.DEBUG === '1' || process.argv.includes('--debug');

  constructor(workingDir: string) {
    super();
    this.workingDir = workingDir;
  }

  start(): void {
    if (this.process) throw new Error('Already running');

    const claudePath = process.env.CLAUDE_PATH || '/Users/anneschuth/.local/bin/claude';
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',  // Auto-approve for bot use
    ];

    console.log(`[Claude] Starting: ${claudePath} ${args.join(' ')}`);

    this.process = spawn(claudePath, args, {
      cwd: this.workingDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.parseOutput(chunk.toString());
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[Claude stderr] ${chunk.toString().trim()}`);
    });

    this.process.on('error', (err) => {
      console.error('[Claude] Error:', err);
      this.emit('error', err);
    });

    this.process.on('exit', (code) => {
      console.log(`[Claude] Exited ${code}`);
      this.process = null;
      this.buffer = '';
      this.emit('exit', code);
    });
  }

  // Send a user message via JSON stdin
  sendMessage(content: string): void {
    if (!this.process?.stdin) throw new Error('Not running');

    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content }
    }) + '\n';
    console.log(`[Claude] Sending: ${content.substring(0, 50)}...`);
    this.process.stdin.write(msg);
  }

  // Send a tool result response
  sendToolResult(toolUseId: string, content: unknown): void {
    if (!this.process?.stdin) throw new Error('Not running');

    const msg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: typeof content === 'string' ? content : JSON.stringify(content)
        }]
      }
    }) + '\n';
    console.log(`[Claude] Sending tool_result for ${toolUseId}`);
    this.process.stdin.write(msg);
  }

  private parseOutput(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed) as ClaudeEvent;
        if (this.debug) {
          console.log(`[DEBUG] Event: ${event.type}`, JSON.stringify(event).substring(0, 200));
        }
        this.emit('event', event);
      } catch {
        if (this.debug) {
          console.log(`[DEBUG] Raw: ${trimmed.substring(0, 200)}`);
        }
      }
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  kill(): void {
    this.process?.kill('SIGTERM');
    this.process = null;
  }
}
