import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ENV_KEYS = ['NX_SEARCH_DB', 'NX_SEARCH_CONFIG', 'NX_AUDIT_LOG', 'JARVIS_NX_ENABLED'];

/**
 * A throwaway nx-search home: <tmp>/root is the only configured root, the index, config and audit log live beside it.
 * Environment variables are restored when the test ends.
 */
export async function makeEnv(t, { security = {}, secretPatterns = [], roots, extra = {} } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nx-t-')));
  const root = join(base, 'root');
  await mkdir(root, { recursive: true });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dbFile = join(base, 'index.db');
  const configFile = join(base, 'config.json');
  const auditFile = join(base, 'audit.log');
  await writeFile(configFile, JSON.stringify({
    roots: roots ?? [root],
    secret_exclude_patterns: secretPatterns,
    security: { audit_logging: true, ...security },
    ...extra,
  }));
  process.env.NX_SEARCH_DB = dbFile;
  process.env.NX_SEARCH_CONFIG = configFile;
  process.env.NX_AUDIT_LOG = auditFile;
  const db = await import('../lib/db.js');
  const search = await import('../lib/search.js');
  search.resetRateLimits();
  t.after(async () => {
    db.closeDb(dbFile);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, dbFile, configFile, auditFile, db, search };
}

export async function put(root, rel, content = 'x') {
  const full = join(root, ...rel.split('/'));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
}

export function indexedPaths(db, root) {
  return db.openDb().prepare('SELECT path FROM files ORDER BY path').all()
    .map((r) => r.path.slice(root.length + 1).split('\\').join('/'));
}

export function bodyOf(db, root, rel) {
  const full = join(root, ...rel.split('/'));
  return db.openDb().prepare('SELECT body FROM content WHERE path = ?').get(full)?.body;
}
