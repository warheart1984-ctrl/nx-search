import { audit } from './audit.js';
import { dbPath, openDb } from './db.js';
import { getPolicy } from './policy.js';
import { queryTerms, redactedSnippet } from './snippet.js';

// Rate limiting: per caller, in this process. The caller is chosen by the embedding code (CLI, MCP, web UI), never by
// a remote request, and the table is bounded so a stream of new names cannot grow it without limit.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_CALLERS = 256;
const rateLimitMap = new Map();

function checkRateLimit(caller, limit) {
  const now = Date.now();
  const key = String(caller ?? 'default').slice(0, 64);
  const recent = (rateLimitMap.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= limit) {
    rateLimitMap.set(key, recent);
    return false;
  }
  recent.push(now);
  rateLimitMap.delete(key);
  rateLimitMap.set(key, recent);
  while (rateLimitMap.size > MAX_TRACKED_CALLERS) rateLimitMap.delete(rateLimitMap.keys().next().value);
  return true;
}

export function resetRateLimits() {
  rateLimitMap.clear();
}

/**
 * The shared front door for anything that searches the index: applies the rate limit and writes the audit record.
 * Used by searchIndex and by RAG retrieval so no search path skips them.
 */
export function beginSearch({ op = 'search', caller = 'default', query }) {
  const policy = getPolicy();
  const security = policy.config.security;
  if (!checkRateLimit(caller, security.rate_limit_qpm)) return { allowed: false, policy, security };
  audit({ op, caller, query }, security);
  return { allowed: true, policy, security };
}

export function fmtSize(n) {
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n > 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n + ' B';
}

export function searchIndex(query, { nameOnly = false, limit = 25, highlight = false, caller = 'default' } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return {
      query: q,
      emptyIndex: false,
      indexedFiles: 0,
      dbPath: dbPath(),
      content: [],
      filenames: [],
      error: 'missing query',
    };
  }

  const { allowed, policy, security } = beginSearch({ op: 'search', caller, query: q });
  if (!allowed) {
    return {
      query: q,
      emptyIndex: false,
      indexedFiles: 0,
      dbPath: dbPath(),
      content: [],
      filenames: [],
      error: 'RATE_LIMITED',
    };
  }

  const db = openDb();
  const indexedFiles = Number(db.prepare('SELECT COUNT(*) AS c FROM files').get()?.c || 0);
  const cap = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), security.search_result_cap);
  let content = [];
  if (!nameOnly) {
    const terms = queryTerms(q);
    const stmt = db.prepare(`
      SELECT rowid AS id, path, bm25(content) AS rank
      FROM content WHERE content MATCH ?
      ORDER BY rank LIMIT ?
    `);
    const bodyStmt = db.prepare('SELECT body FROM content WHERE rowid = ?');
    const scored = new Map();
    for (const ftsQuery of contentQueries(q)) {
      try {
        for (const row of stmt.all(ftsQuery, cap)) {
          const cur = scored.get(row.path);
          if (!cur || row.rank < cur.rank) {
            scored.set(row.path, {
              path: row.path,
              snippet: redactedSnippet(bodyStmt.get(row.id)?.body, terms, policy, { maxChars: 160, highlight }),
              rank: row.rank,
            });
          }
        }
      } catch {
        // malformed FTS query — try the next fallback
      }
      if (scored.size >= cap) break;
    }
    content = [...scored.values()].sort((a, b) => a.rank - b.rank).slice(0, cap);
  }

  const tokens = q.split(/\s+/).filter(Boolean);
  const where = tokens.map(() => 'path LIKE ?').join(' AND ');
  const filenames = db.prepare(`
    SELECT path, size FROM files
    WHERE ${where}
    ORDER BY mtime DESC LIMIT ?
  `).all(...tokens.map((t) => `%${t}%`), cap).map((h) => ({
    path: h.path,
    size: h.size,
    sizeLabel: fmtSize(h.size),
  }));

  return {
    query: q,
    emptyIndex: indexedFiles === 0,
    indexedFiles,
    dbPath: dbPath(),
    content,
    filenames,
    hint: indexedFiles === 0
      ? 'Index is empty. Run `nx scan <paths>` (or `npm run scan -- <paths>`) before searching.'
      : undefined,
  };
}

function contentQueries(q) {
  const tokens = q
    .split(/\s+/)
    .map((token) => token.replace(/"/g, '').trim())
    .filter((token) => token.length > 1);
  const quoted = tokens.map((token) => `"${token.replace(/"/g, '""')}"`);
  const queries = [];
  if (quoted.length) queries.push(quoted.join(' AND '));
  if (quoted.length > 1) queries.push(quoted.join(' OR '));
  return queries;
}

export function indexStats() {
  const db = openDb();
  const indexedFiles = Number(db.prepare('SELECT COUNT(*) AS c FROM files').get()?.c || 0);
  const fullTextBodies = Number(db.prepare("SELECT COUNT(*) AS c FROM files WHERE text_status='ok'").get()?.c || 0);
  const bytes = Number(db.prepare('SELECT SUM(size) AS s FROM files').get()?.s || 0);
  const byVolume = db.prepare(`
    SELECT volume, COUNT(*) AS c, SUM(size) AS s FROM files GROUP BY volume ORDER BY c DESC
  `).all().map((v) => ({
    volume: v.volume,
    files: v.c,
    bytes: v.s || 0,
    sizeLabel: fmtSize(v.s || 0),
  }));
  const topExtensions = db.prepare(`
    SELECT ext, COUNT(*) AS c FROM files WHERE ext != '' GROUP BY ext ORDER BY c DESC LIMIT 12
  `).all().map((e) => ({ ext: e.ext || '(none)', count: e.c }));

  return {
    dbPath: dbPath(),
    indexedFiles,
    fullTextBodies,
    bytes,
    bytesLabel: fmtSize(bytes),
    byVolume,
    topExtensions,
    emptyIndex: indexedFiles === 0,
    hint: indexedFiles === 0
      ? 'Index is empty. Run `nx scan <paths>` before searching drives.'
      : undefined,
  };
}