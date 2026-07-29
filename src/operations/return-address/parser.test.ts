import { describe, it, expect } from 'bun:test';
import { buildDeliveredAnswerFooter, buildReturnAddressMarker, findReturnAddressUrl } from './parser.js';

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

/**
 * The machine marker. Both forms have to parse at the same time — the prompts
 * still teach agents the prose, while code emits the marker, and the whole
 * point of introducing it before retiring the old form is that no message
 * falls between the two and loses its return address.
 */
describe('findReturnAddressUrl — machine marker', () => {
  it('reads what the emitter writes', () => {
    expect(findReturnAddressUrl(buildReturnAddressMarker(PL))).toBe(PL);
  });

  it('needs no prose around it', () => {
    expect(findReturnAddressUrl(`Готово, вердикт APPROVE.\n\n---\nreply-to: ${PL}`)).toBe(PL);
  });

  it('takes the marker over a prose directive in the same message', () => {
    // A bot forwarding a human's request carries both; the marker is the one
    // written on purpose by code.
    expect(
      findReturnAddressUrl(`отвечай мне в тред: ${OTHER}\n\nreply-to: ${PL}`)
    ).toBe(PL);
  });

  it('is case-insensitive and tolerates decoration', () => {
    expect(findReturnAddressUrl(`↩ Reply-To:  ${PL}`)).toBe(PL);
  });

  it('strips trailing sentence punctuation', () => {
    expect(findReturnAddressUrl(`reply-to: ${PL}.`)).toBe(PL);
  });

  it('does not match compounds that merely end in the token', () => {
    expect(findReturnAddressUrl(`no-reply-to: ${PL}`)).toBeNull();
  });

  it('needs a URL right after the marker', () => {
    expect(findReturnAddressUrl('reply-to: (см. выше)')).toBeNull();
  });
});

/**
 * A delivered answer carries a link back to the answerer's thread as provenance.
 * Reading it as an address hijacked the requester's session: we post
 * "@bebop <answer> … <our thread>" into bebop's thread, bebop's bot is woken by
 * the mention, re-parses the message, and its return address now points at OUR
 * thread — so the next answer bebop writes for someone else is delivered to us.
 */
describe('findReturnAddressUrl — delivered answers are not addresses', () => {
  it('ignores the backlink on our own delivered answer', () => {
    expect(findReturnAddressUrl(`@bebop VERDICT: PASS\n\n---\n${buildDeliveredAnswerFooter(PL)}`))
      .toBeNull();
  });

  it('ignores it even when the answer text itself talks about threads', () => {
    expect(findReturnAddressUrl(
      `@bebop ответил тебе в тред, смотри выше\n\n---\n${buildDeliveredAnswerFooter(PL)}`
    )).toBeNull();
  });

  /**
   * A real request that quotes a previous delivered answer as context — routine
   * when work is passed onward. Its OWN directive must still be read, or the
   * answer never arrives: captureReturnAddress fails silently on a missing URL.
   */
  it('still reads a request that quotes an earlier delivered answer', () => {
    const quoted = buildDeliveredAnswerFooter('https://chat.corp/_redirect/pl/oldthread');
    expect(findReturnAddressUrl(
      `Контекст того, что уже сделано:\n\n> @bebop вердикт PASS\n> ${quoted}\n\n`
      + `Теперь доделай пункт 5. reply-to: ${PL}`
    )).toBe(PL);
  });

  it('still reads a request that merely mentions the token', () => {
    expect(findReturnAddressUrl(`сделай ревью, reply-to: ${PL}`)).toBe(PL);
  });
});
