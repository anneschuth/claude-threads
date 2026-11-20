import { describe, test, expect, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  MAX_CONCURRENT_INTERCEPTORS,
  parseInterceptResult,
  resolveMessageInterceptor,
  runMessageInterceptor,
  type InterceptRequest,
} from './message-interceptor.js';

const REQUEST: InterceptRequest = {
  version: 1,
  platformId: 'mm',
  threadId: 'thread1',
  postId: 'post1',
  username: 'alice',
  message: '1A, 2B',
  session: 'active',
};

const node = (script: string) => ({ command: [process.execPath, '-e', script] });

describe('resolveMessageInterceptor', () => {
  test('undefined and null are off', () => {
    expect(resolveMessageInterceptor(undefined, 'p')).toBeUndefined();
    expect(resolveMessageInterceptor(null, 'p')).toBeUndefined();
  });

  test('a valid argv and timeout pass through', () => {
    expect(resolveMessageInterceptor({ command: ['/bin/x', '--y'], timeoutMs: 500 }, 'p')).toEqual({
      command: ['/bin/x', '--y'],
      timeoutMs: 500,
    });
  });

  test.each([
    ['a string command (no shell)', { command: '/bin/x --y' }],
    ['an empty argv', { command: [] }],
    ['an empty argument', { command: ['/bin/x', ''] }],
    ['a non-integer timeout', { command: ['/bin/x'], timeoutMs: 1.5 }],
    ['a zero timeout', { command: ['/bin/x'], timeoutMs: 0 }],
    ['a bare string', '/bin/x'],
  ])('%s warns and turns the feature off', (_label, value) => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveMessageInterceptor(value, 'platforms[mm].messageInterceptor')).toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain('platforms[mm].messageInterceptor');
    warn.mockRestore();
  });
});

describe('parseInterceptResult', () => {
  test('only handled: true counts', () => {
    expect(parseInterceptResult('{"handled": true}')).toEqual({ handled: true, reply: undefined, reaction: undefined });
    expect(parseInterceptResult('{"handled": "yes"}')).toEqual({ handled: false });
    expect(parseInterceptResult('{"handled": false, "reply": "x"}')).toEqual({ handled: false });
    expect(parseInterceptResult('not json')).toEqual({ handled: false });
    expect(parseInterceptResult('')).toEqual({ handled: false });
    expect(parseInterceptResult('null')).toEqual({ handled: false });
  });

  test('a present but unusable reply or reaction is not handled', () => {
    expect(parseInterceptResult('{"handled": true, "reply": "  "}')).toEqual({ handled: false });
    expect(parseInterceptResult('{"handled": true, "reply": 3}')).toEqual({ handled: false });
    expect(parseInterceptResult('{"handled": true, "reaction": "x y"}')).toEqual({ handled: false });
    expect(parseInterceptResult('{"handled": true, "reply": "done", "reaction": "white_check_mark"}')).toEqual({
      handled: true,
      reply: 'done',
      reaction: 'white_check_mark',
    });
  });
});

describe('runMessageInterceptor', () => {
  test('the command reads the request on stdin and its answer is returned', async () => {
    const result = await runMessageInterceptor(
      node(`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);` +
        `console.log(JSON.stringify({handled:true,reply:r.username+' picked '+r.message+' in '+r.session}))})`),
      REQUEST,
    );
    expect(result).toEqual({ handled: true, reply: 'alice picked 1A, 2B in active', reaction: undefined });
  });

  test('past the concurrency limit a message passes through without a command', async () => {
    const slow = node(`setTimeout(()=>console.log('{"handled":true}'),300)`);
    const running = Array.from({ length: MAX_CONCURRENT_INTERCEPTORS }, () => runMessageInterceptor(slow, REQUEST));
    const started = Date.now();
    expect(await runMessageInterceptor(slow, REQUEST)).toEqual({ handled: false });
    expect(Date.now() - started).toBeLessThan(100);
    for (const result of await Promise.all(running)) expect(result.handled).toBe(true);
  });

  test('a helper the command leaves running is killed when it exits', async () => {
    if (process.platform === 'win32') return;
    const marker = `${tmpdir()}/interceptor-leftover-${process.pid}-${Date.now()}`;
    const leave = `require('child_process').spawn(process.execPath,['-e',` +
      `'setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(JSON.stringify(marker)).slice(1, -1)},"x"),400)'],{stdio:'ignore'}).unref();` +
      `console.log('{"handled":false}')`;
    expect(await runMessageInterceptor(node(leave), REQUEST)).toEqual({ handled: false });
    await new Promise((r) => setTimeout(r, 800));
    expect(existsSync(marker)).toBe(false);
  });

  test('an answer stands even when a helper the command started holds stdout open', async () => {
    if (process.platform === 'win32') return;
    const holder = `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],` +
      `{stdio:['ignore','inherit','ignore']}).unref();console.log('{"handled":true}')`;
    const started = Date.now();
    expect(await runMessageInterceptor({ ...node(holder), timeoutMs: 3000 }, REQUEST)).toEqual({
      handled: true, reply: undefined, reaction: undefined,
    });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  test('a non-zero exit is not handled, whatever it printed', async () => {
    const result = await runMessageInterceptor(node(`console.log('{"handled":true}');process.exit(3)`), REQUEST);
    expect(result).toEqual({ handled: false });
  });

  test('a command that does not answer in time is killed and not handled', async () => {
    const started = Date.now();
    const result = await runMessageInterceptor({ ...node('setTimeout(()=>{},60000)'), timeoutMs: 200 }, REQUEST);
    expect(result).toEqual({ handled: false });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('a missing program is not handled', async () => {
    const result = await runMessageInterceptor({ command: ['/nonexistent/interceptor'] }, REQUEST);
    expect(result).toEqual({ handled: false });
  });

  test('oversized output is not handled', async () => {
    const result = await runMessageInterceptor(node(`process.stdout.write('x'.repeat(200000))`), REQUEST);
    expect(result).toEqual({ handled: false });
  });

  test('a command that exits without reading stdin still counts by its output', async () => {
    const result = await runMessageInterceptor(node(`console.log('{"handled":true,"reaction":"eyes"}')`), REQUEST);
    expect(result).toEqual({ handled: true, reply: undefined, reaction: 'eyes' });
  });

  test('a timeout also ends the helpers the command started', async () => {
    const marker = `ct-intercept-helper-${process.pid}-${Date.now()}`;
    const result = await runMessageInterceptor(
      {
        command: ['/bin/sh', '-c', `"$0" -e 'setTimeout(()=>{},30000)' ${marker} & "$0" -e 'setTimeout(()=>{},30000)' ${marker}`, process.execPath],
        timeoutMs: 500,
      },
      REQUEST,
    );
    expect(result).toEqual({ handled: false });
    await new Promise((r) => setTimeout(r, 200));
    const { execSync } = await import('child_process');
    const left = execSync(`pgrep -f '[c]${marker.slice(1)}' || true`).toString().trim();
    expect(left).toBe('');
  });
});
