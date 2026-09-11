/**
 * Escape a value before interpolating it into a quoted CSS attribute
 * selector (e.g. `[data-step-id="${cssEscape(id)}"]`).
 *
 * Uses the platform `CSS.escape` when available (every browser/WebView this
 * app ships on); the fallback covers environments that lack the global CSS
 * object entirely (jsdom). The fallback escapes exactly what is special
 * inside a double-quoted CSS string — the quote delimiter, the escape
 * character, and control characters (hex-escaped with a trailing space to
 * delimit the sequence) — everything else is literal in a quoted value.
 */
export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be hex-escaped here
  return value.replace(/["\\\u0000-\u001F\u007F]/g, (ch) => {
    if (ch === '"' || ch === '\\') return `\\${ch}`
    return `\\${ch.charCodeAt(0).toString(16)} `
  })
}
