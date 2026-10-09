// Result snippets are cut from the REDACTED body, never from raw text.
//
// SQLite's snippet() discards the surrounding text before anything can redact it, so a fragment from the middle of a
// private-key block (no BEGIN/END line in view) would come back as key material. Instead the hit's whole stored body is
// redacted first and the snippet is cut from that. Rows indexed before the policy existed are the case this protects.

const REDACT_WHOLE_BELOW = 2_000_000; // characters; larger bodies are redacted in a window around the first hit
const WINDOW = 200_000;

/**
 * A slice of a very large body around `at`, widened to take in the whole key block the hit sits in, so a delimiter that is
 * hundreds of thousands of characters away is still in view when the text is redacted. (The other redaction patterns work on
 * single tokens and cannot be split by the slice, which is cut well outside the snippet.)
 */
function windowAround(raw, at) {
  let start = Math.max(0, at - WINDOW);
  let end = Math.min(raw.length, at + WINDOW);
  const begin = raw.lastIndexOf('-----BEGIN ', at);
  if (begin !== -1) {
    const endMarker = raw.indexOf('-----END ', begin);
    if (endMarker === -1 || endMarker > at) {
      start = Math.min(start, begin);
      const close = endMarker === -1 ? raw.length : raw.indexOf('-----', endMarker + 9) + 5;
      end = Math.max(end, close > 4 ? close : raw.length);
    }
  }
  return raw.slice(start, end);
}

export const queryTerms = (q) =>
  String(q).split(/\s+/).map((t) => t.replace(/["*]/g, '').trim().toLowerCase()).filter((t) => t.length > 1);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function firstHit(lower, terms) {
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at !== -1) return at;
  // the index is stemmed (porter), so "indexing" matches "index": fall back to a stem
  for (const t of terms) {
    const i = lower.indexOf(t.slice(0, Math.max(3, t.length - 3)));
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  return at;
}

/** A redacted snippet of `body` around the first hit; `maxChars` is the window, `highlight` adds ANSI colour. */
export function redactedSnippet(body, terms, policy, { maxChars = 160, highlight = false } = {}) {
  let raw = typeof body === 'string' ? body : '';
  if (raw.length > REDACT_WHOLE_BELOW) raw = windowAround(raw, Math.max(0, firstHit(raw.toLowerCase(), terms)));
  const text = policy.redact(raw).replace(/\s+/g, ' ').trim();
  const at = firstHit(text.toLowerCase(), terms);
  const start = Math.max(0, (at === -1 ? 0 : at) - Math.floor(maxChars / 3));
  const end = Math.min(text.length, start + maxChars);
  let out = text.slice(start, end);
  if (highlight && terms.length) out = out.replace(new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi'), '\u001b[33m$1\u001b[0m');
  return `${start > 0 ? '… ' : ''}${out}${end < text.length ? ' …' : ''}`;
}
