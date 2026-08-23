import { readdir, stat, statfs } from 'node:fs/promises';
import { join, extname, basename, dirname, sep } from 'node:path';
import { extractText } from './extract.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache',
  '$RECYCLE.BIN', 'System Volume Information', '.Trash-1000', '.Trash',
  'lost+found', '.venv', 'venv', '.tox', 'target', 'dist', 'build',
  '.rustup', '.cargo', '.npm', '.nvm', '.pnpm-store', '.gradle',
  '.m2', '.nuget', '.gem', '.stack', '.opam', '.elan', '.ghcup',
]);

const DEFAULT_ROOTS = [
  '/',
  '/media/jon/New Volume',
  '/media/jon/DEEA8E6FEA8E442D',
];

export async function scan(roots = DEFAULT_ROOTS, { rebuild = false, onProgress } = {}) {
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

  const queue = roots.map((r) => ({ path: r, depth: 0 }));
  const MAX_DEPTH = 40;
  let batch = [];
  const FLUSH_EVERY = 300;

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
    const { path: dir, depth } = queue.pop();
    if (depth > MAX_DEPTH) continue;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (dir === '/' && ['/proc', '/sys', '/dev', '/run', '/snap', '/tmp'].includes(full)) continue;
        queue.push({ path: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      filesSeen++;
      const st = await stat(full).catch(() => null);
      if (!st) continue;

      const row = {
        path: full,
        volume: full.startsWith('/media/jon/') ? full.split(sep)[3] || full : '/',
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
        } catch {}
      }

      if (lowDisk) {
        row.textStatus = 'disk_guard';
        batch.push({ row, body: '' });
      } else if (st.size > extract_js_MAX_EXTRACT_FILE()) {
        row.textStatus = 'too_big';
        batch.push({ row, body: '' });
      } else {
        const { status, body } = await extractText(full, row.ext, row.name);
        row.textStatus = status;
        if (status === 'ok') textIndexed++;
        batch.push({ row, body });
      }

      if (batch.length >= FLUSH_EVERY) flush();
      if (filesSeen % 500 === 0 && onProgress) onProgress(filesSeen, textIndexed);
    }
  }

  flush();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  return { filesSeen, textIndexed, elapsed, dbPath: dbPath() };
}

function extract_js_MAX_EXTRACT_FILE() {
  return 50_000_000;
}

function dbPath() {
  return process.env.NX_SEARCH_DB || `${process.env.HOME}/.local/share/nx-search/index.db`;
}

export function volumeOf(p) {
  if (p.startsWith('/media/jon/')) return dirname(p).split(sep)[3] || basename(dirname(p));
  return p.split(sep)[1] || '/';
}
