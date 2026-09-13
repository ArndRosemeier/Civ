/**
 * The event log: `role="log"`, accessible name `Events`, one line per engine event.
 * See docs/INTERFACES.md, M8 ("The accessibility contract") and "the UI receives events, not
 * 16k tiles per turn" (PLAN.md §5.4).
 *
 * ## What this panel does, and what it deliberately does not
 *
 * The panel owns **no rendering rule**: a line arrives already rendered by `events.ts` and is
 * appended verbatim. That split matters because the log is the one place a person checks what
 * the engine actually did, and a panel that re-worded, filtered or coalesced lines would be a
 * second account of the turn — free to disagree with the first.
 *
 * The only decisions here are presentation ones and they are all bounded:
 *
 * - the log keeps the most recent `EVENT_LOG_LIMIT` lines (older ones are dropped from the
 *   DOM and from the buffer), because a long game emits tens of thousands of lines and an
 *   unbounded `<ol>` is a memory leak with a scrollbar;
 * - a line is appended, never rewritten, so a later refresh cannot restate history;
 * - the box follows its own tail: the list is bounded by `styles.css` (`max-height`), and
 *   `render` rebuilds it, which resets the scroll offset to the top — so without the scroll below a
 *   player who ended a turn would keep seeing the OLDEST events and the ones the turn just
 *   produced would sit below the fold. The advisory screenshots of a played game
 *   (`e2e/m8-adversarial.spec.ts`) are what caught it; the fix reads a scroll offset and nothing
 *   else, so the panel still holds no engine state;
 * - the buffer is plain strings, so the panel holds no engine state and cannot become a
 *   second copy of the game.
 *
 * Nothing here reads the clock, the DOM position, or randomness: the ordering is the engine's
 * event order and the cap is a constant.
 */

/** How many lines the log keeps. Presentation only — nothing in the engine reads it. */
export const EVENT_LOG_LIMIT = 200;

/**
 * `existing` plus `incoming`, keeping at most `limit` lines and dropping the oldest.
 *
 * Pure, so the fast tier can test the cap and the order without a DOM. A `limit` below 1
 * yields no lines rather than a negative slice: the function is total for any input.
 */
export const appendEventLines = (
  existing: readonly string[],
  incoming: readonly string[],
  limit: number = EVENT_LOG_LIMIT,
): readonly string[] => {
  if (limit < 1) return [];
  const combined = [...existing, ...incoming];
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
};

export interface EventLogHandle {
  readonly element: HTMLElement;
  /** Append already-rendered lines (see `events.ts`) and show them, scrolled to the newest. */
  append(lines: readonly string[]): void;
  /** The lines currently held, oldest first — what a test and the panel both read. */
  lines(): readonly string[];
  clear(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Mount the log into `parent`. The element is `role="log"` named `Events`, holding one `<li>`
 * per line; `aria-live="polite"` mirrors the role's implicit liveness explicitly so the
 * screen-reader behaviour does not depend on which ARIA version a browser implements.
 */
export const mountEventLog = (parent: HTMLElement): EventLogHandle => {
  const doc = parent.ownerDocument;
  const element = el(doc, 'section');
  element.dataset['panel'] = 'events';

  const log = el(doc, 'ol');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Events');
  log.setAttribute('aria-live', 'polite');
  element.append(el(doc, 'h2', 'Events'), log);
  parent.append(element);

  let buffer: readonly string[] = [];

  const render = (): void => {
    log.replaceChildren();
    for (const line of buffer) log.append(el(doc, 'li', line));
    // `replaceChildren` above resets the offset, so the scroll has to be re-applied here rather
    // than by the caller. Presentation only: the buffer, and therefore `lines()`, is untouched.
    log.scrollTop = log.scrollHeight;
  };

  return {
    element,
    append: (lines) => {
      if (lines.length === 0) return;
      buffer = appendEventLines(buffer, lines);
      render();
    },
    lines: () => buffer,
    clear: () => {
      buffer = [];
      render();
    },
  };
};
