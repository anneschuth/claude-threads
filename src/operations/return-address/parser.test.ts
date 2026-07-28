import { describe, it, expect } from 'bun:test';
import { findReturnAddressUrl } from './parser.js';

const PL = 'https://chat.corp.pushwoosh.com/_redirect/pl/w5pmoxp1xtg98y6jfwzop7at6r';
const OTHER = 'https://gitlab.corp.pushwoosh.com/group/repo/-/merge_requests/42';

describe('findReturnAddressUrl', () => {
  it('finds the address in the fleet handoff phrasing', () => {
    expect(
      findReturnAddressUrl(
        `@rocksteady проведи ревью на MR 42. Дай Approve если ок — merge жать НЕ надо. ОБЯЗАТЕЛЬНО отвечай мне В ТРЕД: ${PL}`
      )
    ).toBe(PL);
  });

  it('handles the link on its own line', () => {
    expect(findReturnAddressUrl(`сделай и отпишись в тред:\n${PL}\n\nспасибо`)).toBe(PL);
  });

  it('handles English phrasings', () => {
    expect(findReturnAddressUrl(`review this, then reply in the thread: ${PL}`)).toBe(PL);
    expect(findReturnAddressUrl(`report back in thread ${PL}`)).toBe(PL);
  });

  it('strips trailing sentence punctuation', () => {
    expect(findReturnAddressUrl(`ответ в тред: ${PL}.`)).toBe(PL);
    expect(findReturnAddressUrl(`ответ в тред (${PL})`)).toBe(PL);
  });

  it('ignores links that come BEFORE the directive', () => {
    // The MR link is reference material; the address is the one after.
    expect(findReturnAddressUrl(`посмотри ${OTHER} и ответь в тред: ${PL}`)).toBe(PL);
  });

  it('returns null without a directive — a bare permalink is not an address', () => {
    expect(findReturnAddressUrl(`контекст обсуждали тут: ${PL}`)).toBeNull();
    expect(findReturnAddressUrl(`почини баг, вот MR ${OTHER}`)).toBeNull();
  });

  it('returns null for a directive with no link after it', () => {
    expect(findReturnAddressUrl('отвечай мне в тред пожалуйста')).toBeNull();
    expect(findReturnAddressUrl(`${PL} — отвечай мне в тред`)).toBeNull();
  });

  it('does not treat ordinary prose about threads as a directive', () => {
    expect(findReturnAddressUrl(`почини race condition в thread pool, см. ${OTHER}`)).toBeNull();
  });

  it('is safe on empty input', () => {
    expect(findReturnAddressUrl('')).toBeNull();
  });

  it('is not affected by regex lastIndex across calls', () => {
    const msg = `ответь в тред: ${PL}`;
    expect(findReturnAddressUrl(msg)).toBe(PL);
    expect(findReturnAddressUrl(msg)).toBe(PL);
  });
});
