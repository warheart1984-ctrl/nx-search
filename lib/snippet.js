// Result snippets are cut from the REDACTED body, never from raw text, and located by the same tokenizer that matched.
//
// SQLite's snippet() discards the surrounding text before anything can redact it, so a fragment from the middle of a
// private-key block (no BEGIN/END line in view) would come back as key material. Instead the hit's whole stored body is
// redacted first, then loaded into a throwaway in-memory FTS5 table with the same tokenizer (porter + unicode61) and
// queried with the same MATCH expression; its snippet() picks the passage that holds the most matches, with stemming,
// hyphens and multi-term queries handled exactly as the index handled them.

const REDACT_WHOLE_BELOW = 2_000_000; // characters; larger bodies are redacted in a window around the first hit
const WINDOW = 200_000;
const MARK_A = '';
const MARK_B = '';
const prepared = new WeakSet();

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

/**
 * A redacted snippet for the content row `rowid` that matched `ftsQuery`. `tokens` is the window FTS5 aims for;
 * `highlight` adds ANSI colour to the matched words (after redaction).
 */
export function redactedSnippet(db, rowid, ftsQuery, policy, { tokens = 14, highlight = false } = {}) {
  const row = db.prepare('SELECT body FROM content WHERE rowid = ?').get(rowid);
  let raw = typeof row?.body === 'string' ? row.body : '';
  if (raw.length > REDACT_WHOLE_BELOW) {
    let at = 0;
    try {
      const hit = db.prepare('SELECT instr(highlight(content, 1, ?, ?), ?) AS p FROM content WHERE content MATCH ? AND rowid = ?')
        .get(MARK_A, MARK_B, MARK_A, ftsQuery, rowid);
      at = Math.max(0, Number(hit?.p ?? 1) - 1);
    } catch {
      /* no offset: window from the start */
    }
    raw = windowAround(raw, at);
  }
  const clean = policy.redact(raw);

  let out;
  try {
    if (!prepared.has(db)) {
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.nx_snip USING fts5(body, tokenize = 'porter unicode61')");
      prepared.add(db);
    }
    db.exec('DELETE FROM temp.nx_snip');
    db.prepare('INSERT INTO temp.nx_snip (rowid, body) VALUES (1, ?)').run(clean);
    out = db.prepare("SELECT snippet(nx_snip, 0, ?, ?, ' … ', ?) AS s FROM temp.nx_snip WHERE nx_snip MATCH ?")
      .get(MARK_A, MARK_B, tokens, ftsQuery)?.s;
  } catch {
    out = undefined;
  }
  if (!out) {
    // nothing left to match after redaction (the hit was the secret itself): show the start of the redacted text
    const head = clean.slice(0, tokens * 12);
    out = head + (clean.length > head.length ? ' …' : '');
  }
  out = String(out).replace(/\s+/g, ' ').trim();
  return highlight
    ? out.split(MARK_A).join('\u001b[33m').split(MARK_B).join('\u001b[0m')
    : out.replace(/[]/g, '');
}
