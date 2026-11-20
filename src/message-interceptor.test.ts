import { describe, test, expect, spyOn } from 'bun:test';
import {
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

  test('a blank reply and a malformed reaction are dropped', () => {
    expect(parseInterceptResult('{"handled": true, "reply": "  ", "reaction": "x y"}')).toEqual({
      handled: true,
      reply: undefined,
      reaction: undefined,
    });
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
});
