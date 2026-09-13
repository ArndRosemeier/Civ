/**
 * The event log's buffer: order preserved, oldest lines dropped at the cap.
 *
 * The log is the one panel whose content comes from outside the state, so what is worth testing
 * here is exactly the part that could lose a line: appending must preserve order, and the cap
 * must drop from the *front*. Everything about how a line reads is `events.ts`' job and is
 * tested there.
 */

import { describe, expect, it } from 'vitest';
import { EVENT_LOG_LIMIT, appendEventLines } from '../../src/panels/eventlog.js';

describe('appendEventLines', () => {
  it("preserves the engine's event order", () => {
    expect(appendEventLines(['a', 'b'], ['c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
    expect(appendEventLines([], ['first', 'second'])).toEqual(['first', 'second']);
  });

  it('keeps the most recent lines and drops the oldest at the cap', () => {
    expect(appendEventLines(['a', 'b', 'c'], ['d', 'e'], 4)).toEqual(['b', 'c', 'd', 'e']);
    expect(appendEventLines([], ['a', 'b', 'c'], 2)).toEqual(['b', 'c']);
  });

  it('returns the input unchanged when nothing is appended', () => {
    expect(appendEventLines(['a'], [])).toEqual(['a']);
  });

  it('is total for a cap that cannot hold anything', () => {
    expect(appendEventLines(['a'], ['b'], 0)).toEqual([]);
    expect(appendEventLines(['a'], ['b'], -3)).toEqual([]);
  });

  it('has a cap large enough to be useful and small enough to be bounded', () => {
    expect(EVENT_LOG_LIMIT).toBeGreaterThan(50);
    expect(EVENT_LOG_LIMIT).toBeLessThan(10_000);
  });
});
