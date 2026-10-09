import { readdir, stat, statfs } from 'node:fs/promises';
import { basename, dirname, extname, join, sep } from 'node:path';
import { audit } from './audit.js';
import { dbPath } from './db.js';
import { extractText } from './extract.js';
import { getPolicy } from './policy.js';

const MAX_DEPTH = 40;
const FLUSH_EVERY = 300;
const MAX_EXTRACT_FILE = 50_000_000;

/**
 * Index files under `roots` (default: the configured roots). Every root must be inside the configured roots and
 * must not be a system location; secret files, denied or gitignored directories and files are skipped; text is
 * redacted before it is stored. The same policy is applied by `nx watch`.
 */
async function scan(roots, { rebuild = false, onProgress } = {}) {
  const policy = getPolicy({ requireRoots: true });
  const resolvedRoots = policy.resolveRoots(roots);
  const { openDb, upsertFile, replaceBody, insertBody, findUnchanged } = await import('./db.js');
  const db = openDb({ durable: false });

  if (rebuild) {
    db.exec('DELETE FROM files; DELETE FROM content;');
  }

  let filesSeen = 0;
  let textIndexed = 0;
  let lowDisk = false;
  const startedAt = Date.now();

  const insertStmt = upsertFile(db);
  const delBodyStmt = replaceBody(db);
  const insBodyStmt = insertBody(db);
  const unchangedStmt = findUnchanged(db);

  const queue = resolvedRoots.map((r) => ({ path: r, depth: 0, root: r }));
  let batch = [];

  function flush() {
    if (!batch.length) return;
    const tx = db.transaction(() => {
      for (const item of batch) {
        const { id } = insertStmt.get(item.row);
        delBodyStmt.run(id);
        if (item.body) insBodyStmt.run(id, item.row.path, item.body);
      }
    });
    tx();
    batch = [];
  }

  while (queue.length) {
    const { path: dir, depth, root } = queue.pop();
    if (depth > MAX_DEPTH) continue;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (policy.shouldDescend(full, entry.name, root)) queue.push({ path: full, depth: depth + 1, root });
        continue;
      }
      if (!entry.isFile()) continue;
      if (policy.fileViolation(full, { root })) continue;

      filesSeen++;
      const st = await stat(full).catch(() => null);
      if (!st) continue;

      const row = {
        path: full,
        volume: volumeOf(full),
        name: entry.name,
        ext: extname(entry.name).toLowerCase(),
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        indexedAt: Date.now(),
        textStatus: 'pending',
      };

      const unchanged = unchangedStmt.get(full, row.size, row.mtime);
      if (unchanged) {
        insertStmt.get({ ...row, textStatus: 'unchanged' });
        if (filesSeen % 2000 === 0 && onProgress) onProgress(filesSeen, textIndexed);
        continue;
      }

      if (filesSeen % 4000 === 0) {
        try {
          const { bavail, bsize } = await statfs(dirname(dbPath()));
          lowDisk = bavail * bsize < 5_000_000_000;
          if (lowDisk && onProgress) onProgress(filesSeen, -1);
        } catch {
          /* statfs is advisory */
        }
      }

      if (lowDisk) {
        row.textStatus = 'disk_guard';
        batch.push({ row, body: '' });
      } else if (st.size > MAX_EXTRACT_FILE) {
        row.textStatus = 'too_big';
        batch.push({ row, body: '' });
      } else {
        const { status, body } = await extractText(full, row.ext, row.name);
        row.textStatus = status;
        if (status === 'ok') textIndexed++;
        batch.push({ row, body: status === 'ok' ? policy.redact(body) : body });
      }

      if (batch.length >= FLUSH_EVERY) flush();
      if (filesSeen % 500 === 0 && onProgress) onProgress(filesSeen, textIndexed);
    }
  }

  flush();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  audit({ op: 'scan', caller: 'scan', query: resolvedRoots.join(','), result: { filesSeen, textIndexed, elapsed, dbPath: dbPath() } }, policy.config.security);
  return { filesSeen, textIndexed, elapsed, dbPath: dbPath() };
}

function volumeOf(p) {
  if (process.platform === 'win32') {
    const m = String(p).match(/^[A-Za-z]:/);
    return m ? m[0].toUpperCase() : 'unknown';
  }
  if (p.startsWith('/media/jon/')) return dirname(p).split(sep)[3] || basename(dirname(p));
  return p.split(sep)[1] || '/';
}

export { scan as default, scan, volumeOf };
