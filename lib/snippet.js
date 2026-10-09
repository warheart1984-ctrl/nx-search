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

// Terms as the FTS tokenizer sees them (unicode61 splits on anything that is not a letter or digit), so "needle-phrase",
// which matches the text "needle phrase", is looked for as two words.
export const queryTerms = (q) =>
  [...new Set(String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1))];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MAX_OCCURRENCES = 2000;

function occurrences(lower, needle) {
  const found = [];
  for (let i = lower.indexOf(needle); i !== -1 && found.length < MAX_OCCURRENCES; i = lower.indexOf(needle, i + 1)) found.push(i);
  return found;
}

/**
 * Where to centre the snippet: the start of the span of `span` characters that contains the most distinct query terms
 * (earliest on a tie), so a passage holding every term wins over an early lone mention. -1 if nothing matches.
 */
function firstHit(lower, terms, span = 160) {
  let hits = [];
  terms.forEach((t, k) => occurrences(lower, t).forEach((pos) => hits.push([pos, k])));
  if (!hits.length) {
    // the index is stemmed (porter), so "indexing" matches "index": fall back to a stem
    terms.forEach((t, k) => occurrences(lower, t.slice(0, Math.max(3, t.length - 3))).forEach((pos) => hits.push([pos, k])));
  }
  if (!hits.length) return -1;
  hits.sort((a, b) => a[0] - b[0]);
  const inWindow = new Map();
  let best = { distinct: 0, pos: hits[0][0] };
  let j = 0;
  for (let i = 0; i < hits.length; i += 1) {
    while (j < hits.length && hits[j][0] - hits[i][0] <= span) {
      inWindow.set(hits[j][1], (inWindow.get(hits[j][1]) ?? 0) + 1);
      j += 1;
    }
    if (inWindow.size > best.distinct) best = { distinct: inWindow.size, pos: hits[i][0] };
    const k = hits[i][1];
    inWindow.set(k, inWindow.get(k) - 1);
    if (inWindow.get(k) === 0) inWindow.delete(k);
  }
  return best.pos;
}

/** A redacted snippet of `body` around the first hit; `maxChars` is the window, `highlight` adds ANSI colour. */
export function redactedSnippet(body, terms, policy, { maxChars = 160, highlight = false } = {}) {
  let raw = typeof body === 'string' ? body : '';
  if (raw.length > REDACT_WHOLE_BELOW) raw = windowAround(raw, Math.max(0, firstHit(raw.toLowerCase(), terms)));
  const text = policy.redact(raw).replace(/\s+/g, ' ').trim();
  const at = firstHit(text.toLowerCase(), terms, maxChars);
  const start = Math.max(0, (at === -1 ? 0 : at) - Math.floor(maxChars / 3));
  const end = Math.min(text.length, start + maxChars);
  let out = text.slice(start, end);
  if (highlight && terms.length) out = out.replace(new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi'), '\u001b[33m$1\u001b[0m');
  return `${start > 0 ? '… ' : ''}${out}${end < text.length ? ' …' : ''}`;
}
