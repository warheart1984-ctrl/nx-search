// Result snippets are cut from the REDACTED body, never from raw text, and located by the same tokenizer that matched.
//
// SQLite's snippet() discards the surrounding text before anything can redact it, so a fragment from the middle of a
// private-key block (no BEGIN/END line in view) would come back as key material. Instead the hit's whole stored body is
// redacted first, then loaded into a throwaway in-memory FTS5 table with the same tokenizer (porter + unicode61) and
// queried with the same MATCH expression; its snippet() picks the passage that holds the most matches, with stemming,
// hyphens and multi-term queries handled exactly as the index handled them.

const MARK_A = '\uE000';
const MARK_B = '\uE001';
const prepared = new WeakSet();

/**
 * A redacted snippet for the content row `rowid` that matched `ftsQuery`. `tokens` is the window FTS5 aims for;
 * `highlight` adds ANSI colour to the matched words (after redaction).
 */
export function redactedSnippet(db, rowid, ftsQuery, policy, { tokens = 14, highlight = false } = {}) {
  const row = db.prepare('SELECT body FROM content WHERE rowid = ?').get(rowid);
  // The WHOLE stored body is redacted, however large: some rules need context that can be far from the hit (a key block's
  // BEGIN line, a YAML `password: |` header, a configured BEGIN..END block), so no window is safe. A very large legacy body
  // therefore costs a full redaction pass per search that returns it; the rate limit and result cap bound how often.
  const raw = typeof row?.body === 'string' ? row.body : '';
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
    : out.replace(/[\uE000\uE001]/g, '');
}
