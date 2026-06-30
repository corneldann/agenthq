// utils.ts — date formatting, colour helpers, DOM utilities
// Feature: monitor-dashboard-redesign

/**
 * formatAge — formats a millisecond duration as "Xs ago".
 * @param ms - elapsed milliseconds (e.g. from Date.now() - timestamp)
 * @returns e.g. "5s ago", "120s ago"
 */
export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${s}s ago`;
}

/**
 * formatDate — formats an ISO 8601 string as "YYYY-MM-DD HH:mm:ss" in local time.
 * @param iso - ISO date string, e.g. "2024-03-15T14:05:09.000Z"
 * @returns e.g. "2024-03-15 14:05:09"
 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const year  = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day   = pad(d.getDate());
  const hours = pad(d.getHours());
  const mins  = pad(d.getMinutes());
  const secs  = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}

/**
 * pluralise — returns "1 chain" or "2 chains" etc.
 * Appends "s" for any count other than 1.
 * @param n    - the count
 * @param word - the singular noun
 */
export function pluralise(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * clampText — truncates a string to maxLen characters.
 * Appends "…" (single ellipsis character) if the string was truncated.
 * @param s      - input string
 * @param maxLen - maximum allowed length (before appending "…")
 */
export function clampText(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

/**
 * el — typed DOM element factory.
 * Creates an element of the given tag, optionally setting attributes and
 * appending child elements or text nodes.
 *
 * @param tag      - a valid HTML tag name (keyof HTMLElementTagNameMap)
 * @param attrs    - optional key/value pairs set via setAttribute
 * @param children - optional array of child HTMLElements or plain strings
 * @returns the created element with correct inferred type
 *
 * @example
 * el('div', { class: 'card' }, [el('span', {}, ['hello']), 'world'])
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: (HTMLElement | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      node.setAttribute(key, val);
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child === 'string') {
        node.appendChild(document.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
  }
  return node;
}

/**
 * statusToClass — maps a Job run status to the CSS modifier used on `.run-dot`.
 *
 * Rules (Requirement 15.2):
 *   - 'done'     → 'run-dot--done'     (green)
 *   - 'error'    → 'run-dot--error'    (red)
 *   - 'running'  → 'run-dot--running'  (blue)
 *   - 'reported' → 'run-dot--reported' (amber)
 *   - any other  → 'run-dot--other'    (grey)
 *
 * @param status - a Job's status string
 */
export function statusToClass(status: string): string {
  switch (status) {
    case 'done':     return 'run-dot--done';
    case 'error':    return 'run-dot--error';
    case 'running':  return 'run-dot--running';
    case 'reported': return 'run-dot--reported';
    default:         return 'run-dot--other';
  }
}

/**
 * sortRunsByTimestamp — sorts an array of run objects ascending by their `timestamp` field.
 *
 * Returns a new array; the original is not mutated.
 * Older timestamps (earlier ISO strings) appear first (left side of the RunTimeline).
 * Requirement 15.1: dots ordered left-to-right ascending by timestamp.
 *
 * @param runs - array of objects that have a `timestamp: string` (ISO 8601) field
 * @returns a new array sorted ascending by timestamp
 */
export function sortRunsByTimestamp<T extends { timestamp: string }>(runs: T[]): T[] {
  return [...runs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

/**
 * contextColour — maps a context-usage percentage to a colour token.
 *
 * Rules (Requirements 14.2–14.5):
 *   - null or outside 0–100 → 'grey'
 *   - pct < 50              → 'green'
 *   - 50 ≤ pct < 70         → 'amber'
 *   - pct ≥ 70              → 'red'
 *
 * @param pct - context usage percentage, or null
 */
export function contextColour(pct: number | null): 'green' | 'amber' | 'red' | 'grey' {
  if (pct === null || pct < 0 || pct > 100) return 'grey';
  if (pct < 50) return 'green';
  if (pct < 70) return 'amber';
  return 'red';
}
