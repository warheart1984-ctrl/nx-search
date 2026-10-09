import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, basename, resolve, sep } from 'node:path';
import { openDb, upsertFile, replaceBody, insertBody, deleteFile, dbPath } from './db.js';
import { extractText } from './extract.js';
import { getPolicy } from './policy.js';
import { scan, volumeOf } from './scanner.js';

const DEFAULT_DEBOUNCE_MS = 750;
const IGNORED_PARTS = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '.cache']);

// The index must never index itself — watching a root that contains the DB
// (e.g. the default %USERPROFILE% root) would loop write → event → write.
function ownDbFiles() {
  const base = resolve(dbPath());
  return new Set([base, `${base}-wal`, `${base}-shm`, `${base}-journal`]);
}

function ignored(path, ownDb = null) {
  if (ownDb?.has(path)) return true;
  return path.split(/[\\/]+/).some((part) => IGNORED_PARTS.has(part))
    || /(?:^|[\\/])[^\\/]+\.lock$/i.test(path);
}

/**
 * Remove index rows whose files no longer exist under the given roots.
 * The live watcher only sees changes while it runs; this pass repairs drift
 * accumulated while nothing was watching. Returns { checked, removed }.
 */
export async function pruneMissing(roots, { onEvent } = {}) {
  const db = openDb({ durable: true });
  const remove = deleteFile(db);
  let checked = 0;
  let removed = 0;

  for (const rawRoot of roots) {
    const root = resolve(rawRoot);
    const rootLower = root.toLowerCase();
    const rootPrefix = rootLower.endsWith(sep) ? rootLower : rootLower + sep;
    // Narrow by volume first; LIKE-free prefix match on the slice.
    const rows = db
      .prepare(`SELECT path FROM files WHERE volume = ?`)
      .all(volumeOf(root));
    for (const row of rows) {
      const p = row.path.toLowerCase();
      if (p !== rootLower && !p.startsWith(rootPrefix)) continue;
      checked += 1;
      const file = await stat(row.path).catch(() => null);
      if (!file || !file.isFile()) {
        remove.run(row.path);
        removed += 1;
        onEvent?.({ type: 'prune', path: row.path });
      }
      if (checked % 2000 === 0) {
        onEvent?.({ type: 'reconcile', checked, removed });
      }
    }
  }
  onEvent?.({ type: 'reconcile', checked, removed });
  return { checked, removed };
}

/**
 * The per-path indexing step of `nx watch`, with the same policy as `nx scan`: a secret file, a denied or gitignored
 * path or anything outside the configured roots is never indexed (and is dropped if it was), and text is redacted
 * before it is stored.
 */
export function createPathIndexer({ db, policy, ownDb = null, onEvent }) {
  // `policy` may be a function: the watcher passes one so every event is judged by the CURRENT config, not the one that
  // was loaded when the watcher started (tightening the config takes effect on the next change; rows already stored are
  // cleaned up by `nx purge-unsafe`).
  const current = () => (typeof policy === 'function' ? policy() : policy);
  const insert = upsertFile(db);
  const clearBody = replaceBody(db);
  const addBody = insertBody(db);
  const remove = deleteFile(db);

  return async function updatePath(rawPath) {
    const path = resolve(rawPath);
    if (ignored(path, ownDb)) return;
    const file = await stat(path).catch(() => null);
    if (!file || !file.isFile()) {
      remove.run(path);
      onEvent?.({ type: 'delete', path });
      return;
    }
    const rules = current();
    const violation = rules.fileViolation(path, { deep: true });
    if (violation) {
      remove.run(path);
      onEvent?.({ type: 'skip', path, reason: violation });
      return;
    }
    const name = basename(path);
    const ext = extname(name).toLowerCase();
    const row = {
      path,
      volume: volumeOf(path),
      name,
      ext,
      size: file.size,
      mtime: Math.floor(file.mtimeMs),
      indexedAt: Date.now(),
      textStatus: 'pending',
    };
    const extracted = file.size <= 50_000_000
      ? await extractText(path, ext, name)
      : { status: 'too_big', body: '' };
    row.textStatus = extracted.status;
    const body = extracted.status === 'ok' ? rules.redact(extracted.body) : extracted.body;
    const tx = db.transaction(() => {
      const { id } = insert.get(row);
      clearBody.run(id);
      if (body) addBody.run(id, path, body);
    });
    tx();
    onEvent?.({ type: 'update', path, textStatus: row.textStatus });
  };
}

/** The indexer `nx watch` uses: every event is judged by the config as it is NOW, so tightening it takes effect at once. */
export function createWatchIndexer({ db, ownDb = null, onEvent }) {
  return createPathIndexer({ db, policy: () => getPolicy({ requireRoots: true }), ownDb, onEvent });
}

export function watchRoots(roots, { debounceMs = DEFAULT_DEBOUNCE_MS, onEvent, reconcile = true } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('nx watch currently requires Windows recursive fs.watch support');
  }
  const policy = getPolicy({ requireRoots: true });
  const watchedRoots = policy.scanTargets(roots).map((t) => t.path);
  const db = openDb({ durable: true });
  const ownDb = ownDbFiles();
  const pending = new Map();
  const timers = new Map();
  const handles = [];
  const updatePath = createWatchIndexer({ db, ownDb, onEvent });

  function schedule(path, eventType) {
    const key = resolve(path);
    if (ignored(key, ownDb)) return;
    pending.set(key, eventType);
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(async () => {
      timers.delete(key);
      pending.delete(key);
      try {
        await updatePath(key);
      } catch (error) {
        onEvent?.({ type: 'error', path: key, error });
      }
    }, debounceMs));
  }

  for (const root of watchedRoots) {
    const handle = watch(root, { recursive: true }, (eventType, filename) => {
      if (filename) schedule(resolve(root, filename.toString()), eventType);
    });
    handles.push(handle);
  }

  // Catch-up pass: watchers are attached first so live events during
  // reconcile are not missed, then scan picks up new/changed files and
  // prune removes rows for files that vanished while unwatched.
  if (reconcile) {
    (async () => {
      try {
        const result = await scan(watchedRoots, {});
        onEvent?.({
          type: 'reconcile-scan',
          filesSeen: result.filesSeen,
          textIndexed: result.textIndexed,
        });
        await pruneMissing(watchedRoots, { onEvent });
      } catch (error) {
        onEvent?.({ type: 'error', path: roots.join(', '), error });
      }
    })();
  }

  return {
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      for (const handle of handles) handle.close();
      db.close();
    },
  };
}
