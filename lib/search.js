import { dbPath, openDb } from './db.js';
import { homedir } from 'node:os';
import { loadNxEnv } from './env.js';
import { join } from 'node:path';

// Load configuration
const CONFIG_PATH = process.env.NX_SEARCH_CONFIG || join(homedir(), '.local', 'share', 'nx-search', '.nx-search-config.json');
let config = { security: { search_result_cap: 50, rate_limit_qpm: 60, audit_logging: true } };
try {
  const cfgRaw = require(CONFIG_PATH);
  config = { ...config, ...cfgRaw, security: { ...config.security, ...cfgRaw.security } };
} catch (e) {
  // Use defaults
}

// Rate limiting state
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function checkRateLimit(caller) {
  const now = Date.now();
  const key = typeof caller === 'string' ? caller : 'default';
  const calls = rateLimitMap.get(key) || [];
  const recent = calls.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= config.security.rate_limit_qpm) {
    return false;
  }
  calls.push(now);
  rateLimitMap.set(key, calls);
  return true;
}

function auditLog(op, query, caller) {
  if (!config.security.audit_logging) return;
  try {
    const auditLog = join(homedir(), '.local', 'share', 'nx-search', 'audit.log');
    const fs = require('fs');
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      caller: caller,
      op: op,
      query: query,
      queryHash: require('crypto').createHash('sha256').update(query).digest('hex'),
      userAgent: process.env.USER_AGENT || 'unknown'
    }) + '\n';
    fs.writeFileSync(auditLog, logEntry, { flag: 'a' });
  } catch (e) {
    // Ignore audit failures
  }
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

  // Rate limiting
  if (!checkRateLimit(caller)) {
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

  // Audit logging
  if (config.security.audit_logging) {
    auditLog('search', q, caller);
  }

  const db = openDb();
  const indexedFiles = Number(db.prepare('SELECT COUNT(*) AS c FROM files').get()?.c || 0);
  const cap = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), config.security.search_result_cap);
  let content = [];
  if (!nameOnly) {
    const start = highlight ? '\u001b[33m' : '';
    const end = highlight ? '\u001b[0m' : '';
    const stmt = db.prepare(`
      SELECT path, snippet(content, 1, '${start}', '${end}', ' … ', 14) AS snippet,
             bm25(content) AS rank
      FROM content WHERE content MATCH ?
      ORDER BY rank LIMIT ?
    `);
    const scored = new Map();
    for (const ftsQuery of contentQueries(q)) {
      try {
        for (const row of stmt.all(ftsQuery, cap)) {
          const cur = scored.get(row.path);
          if (!cur || row.rank < cur.rank) {
            scored.set(row.path, {
              path: row.path,
              snippet: String(row.snippet || '').replace(/\s+/g, ' ').trim(),
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