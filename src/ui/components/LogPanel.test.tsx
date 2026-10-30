import { describe, it, expect } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import { Box, render } from 'ink';
import { LogPanel } from './LogPanel.js';
import type { LogEntry } from '../types.js';

function makeLogs(count: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `log-${i}`,
    timestamp: new Date(0),
    level: 'info' as const,
    component: 'test',
    message: `line-${i}`,
  }));
}

async function renderPanel(logs: LogEntry[][], height = 5): Promise<string> {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  stdout.columns = 80;
  stdout.rows = 24;
  let output = '';
  (stdout as unknown as PassThrough).on('data', (chunk) => {
    if (String(chunk).trim()) output = String(chunk);
  });
  const tree = (entries: LogEntry[]) => (
    <Box height={height} flexDirection="column">
      <LogPanel logs={entries} />
    </Box>
  );
  const app = render(tree(logs[0] ?? []), { stdout, debug: true, exitOnCtrlC: false, patchConsole: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const entries of logs.slice(1)) {
    app.rerender(tree(entries));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  app.unmount();
  return output;
}

describe('LogPanel', () => {
  it('shows the newest logs when they overflow the panel', async () => {
    const output = await renderPanel([makeLogs(20)]);

    expect(output).toContain('line-19');
    expect(output).toContain('line-15');
    expect(output).not.toContain('line-14');
  });

  it('follows new logs when the panel starts empty', async () => {
    const output = await renderPanel([[], makeLogs(3), makeLogs(20)]);

    expect(output).toContain('line-19');
    expect(output).not.toContain('line-14');
  });
});
