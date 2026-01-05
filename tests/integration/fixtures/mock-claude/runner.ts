#!/usr/bin/env bun
/**
 * Mock Claude CLI for integration testing
 *
 * This process mimics the Claude Code CLI behavior:
 * - Reads JSON from stdin (stream-json format)
 * - Writes JSON to stdout (stream-json format)
 * - Loads predefined scenarios for deterministic testing
 *
 * Usage:
 *   CLAUDE_SCENARIO=simple-response bun run tests/integration/fixtures/mock-claude/runner.ts
 *   echo '{"type":"user","message":{"role":"user","content":"hello"}}' | CLAUDE_SCENARIO=simple-response bun run tests/integration/fixtures/mock-claude/runner.ts
 *
 * Environment variables:
 *   CLAUDE_SCENARIO  - Name of scenario to use (default: 'default')
 *   MOCK_DELAY       - Base delay between events in ms (default: 100)
 *   DEBUG            - Set to '1' for debug logging
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(__dirname, 'scenarios');

// ============================================================================
// Types
// ============================================================================

interface MockEvent {
  type: string;
  delay?: number;  // ms before sending this event
  [key: string]: unknown;
}

interface MockScenario {
  name: string;
  description?: string;
  /** Events to send on initial connection */
  initialEvents?: MockEvent[];
  /** Events to send in response to user messages */
  responseEvents?: MockEvent[];
  /** Function-style responses based on user input */
  onMessage?: (message: string) => MockEvent[];
}

// ============================================================================
// Scenario Loading
// ============================================================================

const defaultScenario: MockScenario = {
  name: 'default',
  description: 'Simple echo response',
  initialEvents: [],
  responseEvents: [
    {
      type: 'assistant',
      delay: 100,
      message: {
        content: [
          {
            type: 'text',
            text: 'Hello! I received your message. This is a mock response for testing.',
          },
        ],
      },
    },
    {
      type: 'result',
      delay: 50,
      subtype: 'success',
      cost_usd: 0.001,
      duration_ms: 150,
      duration_api_ms: 100,
      is_error: false,
      num_turns: 1,
      result: '',
      session_id: 'mock-session-id',
      total_cost_usd: 0.001,
    },
  ],
};

function loadScenario(name: string): MockScenario {
  const scenarioPath = join(SCENARIOS_DIR, `${name}.json`);

  if (!existsSync(scenarioPath)) {
    if (name !== 'default') {
      log(`Scenario '${name}' not found, using default`);
    }
    return defaultScenario;
  }

  try {
    const content = readFileSync(scenarioPath, 'utf-8');
    return JSON.parse(content) as MockScenario;
  } catch (error) {
    log(`Error loading scenario '${name}': ${error}`);
    return defaultScenario;
  }
}

// ============================================================================
// Utilities
// ============================================================================

const DEBUG = process.env.DEBUG === '1';

function log(message: string): void {
  if (DEBUG) {
    console.error(`[mock-claude] ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(event: MockEvent): void {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { delay: _delay, ...eventData } = event;
  const line = JSON.stringify(eventData);
  process.stdout.write(line + '\n');
  log(`Emitted: ${event.type}`);
}

// ============================================================================
// Main Process
// ============================================================================

async function processEvents(events: MockEvent[]): Promise<void> {
  const baseDelay = parseInt(process.env.MOCK_DELAY || '100', 10);

  for (const event of events) {
    const delay = event.delay ?? baseDelay;
    if (delay > 0) {
      await sleep(delay);
    }
    emit(event);
  }
}

async function handleUserMessage(message: string, scenario: MockScenario): Promise<void> {
  log(`Received user message: ${message.substring(0, 50)}...`);

  // Check for custom handler
  if (scenario.onMessage) {
    const events = scenario.onMessage(message);
    await processEvents(events);
    return;
  }

  // Use default response events
  if (scenario.responseEvents) {
    await processEvents(scenario.responseEvents);
  }
}

async function main(): Promise<void> {
  const scenarioName = process.env.CLAUDE_SCENARIO || 'default';
  log(`Starting mock Claude CLI with scenario: ${scenarioName}`);

  const scenario = loadScenario(scenarioName);
  log(`Loaded scenario: ${scenario.name} - ${scenario.description || 'no description'}`);

  // Send initial events if any
  if (scenario.initialEvents && scenario.initialEvents.length > 0) {
    await processEvents(scenario.initialEvents);
  }

  // Set up stdin reading
  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', async (line) => {
    try {
      const input = JSON.parse(line);
      log(`Received input type: ${input.type}`);

      if (input.type === 'user') {
        // Extract message content
        const message = input.message;
        let content = '';

        if (typeof message === 'string') {
          content = message;
        } else if (message?.content) {
          if (typeof message.content === 'string') {
            content = message.content;
          } else if (Array.isArray(message.content)) {
            // Handle content blocks
            content = message.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text?: string }) => b.text || '')
              .join('\n');
          }
        }

        await handleUserMessage(content, scenario);
      }
    } catch (error) {
      log(`Error processing input: ${error}`);
    }
  });

  rl.on('close', () => {
    log('stdin closed, exiting');
    process.exit(0);
  });

  // Handle signals gracefully
  process.on('SIGTERM', () => {
    log('Received SIGTERM, exiting');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('Received SIGINT, exiting');
    process.exit(0);
  });
}

// Run if executed directly
if (import.meta.main) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { loadScenario, MockScenario, MockEvent };
