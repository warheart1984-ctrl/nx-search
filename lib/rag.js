import { openDb } from './db.js';

const MAX_CONTEXT_CHARS = 20_000;

const STOP = new Set([
  'the', 'and', 'for', 'what', 'where', 'how', 'who', 'with', 'this', 'that',
  'from', 'are', 'was', 'were', 'is', 'in', 'on', 'of', 'my', 'me', 'i', 'a',
  'an', 'to', 'do', 'does', 'did', 'can', 'you', 'your', 'it', 'its', 'at',
  'be', 'been', 'have', 'has', 'had', 'will', 'would', 'should', 'could',
]);

function keywords(q) {
  return q
    .toLowerCase()
    .split(/[^a-z0-9_.+-]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export function retrieve(question, { perQuery = 10, maxChunks = 14 } = {}) {
  const db = openDb();
  const kw = keywords(question);

  const scored = new Map();

  const contentStmt = db.prepare(`
    SELECT path, snippet(content, 1, '', '', ' … ', 40) AS snip, bm25(content) AS rank
    FROM content WHERE content MATCH ? ORDER BY rank LIMIT ?
  `);
  const pathStmt = db.prepare(`
    SELECT path FROM files
    WHERE ${kw.map(() => 'path LIKE ?').join(' AND ')}
    ORDER BY mtime DESC LIMIT 5
  `);

  const queries = [];
  if (kw.length) {
    queries.push(kw.map((w) => `"${w}"`).join(' AND '));
    if (kw.length > 1) queries.push(kw.map((w) => `"${w}"`).join(' OR '));
  }

  for (const q of queries) {
    let rows = [];
    try {
      rows = contentStmt.all(q, perQuery);
    } catch {
      continue;
    }
    for (const r of rows) {
      const cur = scored.get(r.path) || { path: r.path, bestRank: Infinity, snip: '' };
      if (r.rank < cur.bestRank) {
        cur.bestRank = r.rank;
        cur.snip = r.snip;
      }
      scored.set(r.path, cur);
    }
  }

  const pathMatched = [];
  if (kw.length) {
    try {
      for (const r of pathStmt.all(...kw.map((w) => `%${w}%`))) {
        pathMatched.push(r.path);
      }
    } catch {}
  }

  const chunks = [...scored.values()]
    .sort((a, b) => a.bestRank - b.bestRank)
    .slice(0, maxChunks)
    .map((c) => ({ path: c.path, text: c.snip.replace(/\s+/g, ' ').trim() }));

  return { chunks, pathMatched };
}

export function buildContext(chunks, budget = MAX_CONTEXT_CHARS) {
  const parts = [];
  let used = 0;
  chunks.forEach((c, i) => {
    const entry = `[${i + 1}] ${c.path}\n${c.text}`;
    if (used + entry.length > budget) return;
    parts.push(entry);
    used += entry.length;
  });
  return parts.join('\n\n');
}

export function citationMap(chunks) {
  return chunks.map((c, i) => `[${i + 1}] ${c.path}`);
}
