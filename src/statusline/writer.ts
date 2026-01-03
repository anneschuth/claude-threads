#!/usr/bin/env node
/**
 * Status line writer for claude-threads
 *
 * This script is called by Claude Code's status line feature.
 * It receives JSON data via stdin containing context window usage,
 * writes it to a file for claude-threads to read, and outputs
 * a minimal status line (or empty string to not affect user's status line).
 *
 * The file is written to /tmp/claude-threads-status-<session-id>.json
 *
 * Usage (configured in Claude Code settings):
 *   statusLine: {
 *     type: "command",
 *     command: "node /path/to/writer.js <session-id>"
 *   }
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// Read session ID from command line args
const sessionId = process.argv[2];
if (!sessionId) {
  // No session ID provided - output empty status line and exit
  console.log('');
  process.exit(0);
}

// Read JSON from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // Extract context window usage
    const contextWindow = data.context_window;
    if (contextWindow) {
      const usage = contextWindow.current_usage;
      const output = {
        context_window_size: contextWindow.context_window_size,
        total_input_tokens: contextWindow.total_input_tokens,
        total_output_tokens: contextWindow.total_output_tokens,
        current_usage: usage ? {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        } : null,
        model: data.model ? {
          id: data.model.id,
          display_name: data.model.display_name,
        } : null,
        cost: data.cost ? {
          total_cost_usd: data.cost.total_cost_usd,
        } : null,
        timestamp: Date.now(),
      };

      // Write to temp file
      const filePath = `/tmp/claude-threads-status-${sessionId}.json`;
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(output, null, 2));
    }
  } catch {
    // Silently ignore parse errors
  }

  // Output empty string - don't interfere with user's status line
  // If user has their own status line configured, this won't override it
  console.log('');
});
