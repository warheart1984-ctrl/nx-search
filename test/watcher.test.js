import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { volumeOf } from '../lib/scanner.js';

const IS_WIN = process.platform === 'win32';

async function poll(fn, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function withIndex(t) {
  const root = await mkdtemp(join(tmpdir(), 'nx-watch-'));
  const dbFile = join(root, 'index.db');
  process.env.NX_SEARCH_DB = dbFile;
  
  // Create a config file for the scanner
  const config = {
    roots: [root],
    secret_exclude_patterns: [],
    extra_skip_dirs: [],
    security: {
      encryption: false,
      search_result_cap: 50,
      rate_limit_qpm: 60,
      audit_logging: false,
      redaction_patterns: []
    }
  };
  const configPath = join(root, '.nx-search-config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
  process.env.NX_SEARCH_CONFIG = configPath;
  
  const dbMod = await import('../lib/db.js');
  const watcherMod = await import('../lib/watcher.js');
  t.after(async () => {
    dbMod.closeDb(dbFile);
    await rm(root, { recursive: true, force: true });
  });
  const db = dbMod.openDb();
  return { db: db, dbMod, watcherMod, root };
}

function fileRow(db, filePath) {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(filePath);
}

test('watch indexes a new file, reindexes edits, removes deletes', { skip: !IS_WIN }, async (t) => {
  const { db, watcherMod, root } = await withIndex(t);
  const watcher = watcherMod.watchRoots([root], { debounceMs: 50, reconcile: false });
  t.after(() => watcher.close());

  const target = join(root, 'hello.txt');
  await writeFile(target, 'hello watcher world');

  const indexed = await poll(() => fileRow(db, target));
  assert.ok(indexed, 'new file was not indexed');
  const extracted = await poll(() => {
    const row = fileRow(db, target);
    return row && row.text_status === 'ok' ? row : null;
  });
  assert.ok(extracted, 'new file body was not extracted');

  // Edit must reindex: indexed_at advances past the first write.
  await writeFile(target, 'edited watcher content');
  const reindexed = await poll(() => {
    const row = fileRow(db, target);
    return row && row.indexed_at > extracted.indexed_at ? row : null;
  });
  assert.ok(reindexed, 'edited file was not reindexed');

  await rm(target);
  const gone = await poll(() => !fileRow(db, target));
  assert.ok(gone, 'deleted file was not pruned from index');
});

test('watch never indexes its own database files', { skip: !IS_WIN }, async (t) => {
  const { db, watcherMod, root } = await withIndex(t);
  // The index DB lives inside the watched root — write→event→write would loop.
  const watcher = watcherMod.watchRoots([root], { debounceMs: 50, reconcile: false });
  t.after(() => watcher.close());

  // Trigger writes on the DB (the upsert touches WAL/SHM sidecars too).
  const marker = join(root, 'trigger.txt');
  await writeFile(marker, 'trigger write');
  await poll(() => fileRow(db, marker));
  await new Promise((r) => setTimeout(r, 500));

  const dbFiles = db.prepare(
    "SELECT path FROM files WHERE path LIKE '%index.db%'",
  ).all();
  assert.equal(dbFiles.length, 0, `index indexed itself: ${dbFiles.map((r) => r.path)}`);
});

test('watch reconcile picks up changes made while unwatched', { skip: !IS_WIN }, async (t) => {
  const { db, dbMod, watcherMod, root } = await withIndex(t);

  // Created before the watcher started — only the reconcile scan can see it.
  const preexisting = join(root, 'preexisting.txt');
  await writeFile(preexisting, 'created while unwatched');

  // Ghost Row: indexed under root but the file is gone.
  const ghost = join(root, 'ghost.txt');
  dbMod.upsertFile(db).get({
    path: ghost, volume: watcherMod ? 'C:' : 'C:', name: 'ghost.txt', ext: '.txt',
    size: 1, mtime: 1, indexedAt: 1, textStatus: 'ok',
  });
  assert.ok(fileRow(db, ghost));

  const watcher = watcherMod.watchRoots([root], { debounceMs: 50 });
  t.after(() => watcher.close());

  const found = await poll(() => fileRow(db, preexisting));
  assert.ok(found, 'reconcile scan did not index pre-existing file');
  const pruned = await poll(() => !fileRow(db, ghost));
  assert.ok(pruned, 'reconcile did not remove vanished file');
});

test('pruneMissing removes vanished files only under the given root', async (t) => {
  const { db, dbMod, watcherMod, root } = await withIndex(t);
  const real = join(root, 'real.txt');
  await writeFile(real, 'still here');

  const upsert = dbMod.upsertFile(db);
  const inside = join(root, 'vanished.txt');
  const outside = join(tmpdir(), 'nx-watch-outside-stays.txt');
  upsert.get({ path: inside, volume: volumeOf(inside), name: 'vanished.txt', ext: '.txt', size: 1, mtime: 1, indexedAt: 1, textStatus: 'ok' });
  upsert.get({ path: outside, volume: volumeOf(outside), name: 'nx-watch-outside-stays.txt', ext: '.txt', size: 1, mtime: 1, indexedAt: 1, textStatus: 'ok' });
  upsert.get({ path: real, volume: volumeOf(real), name: 'real.txt', ext: '.txt', size: 9, mtime: 1, indexedAt: 1, textStatus: 'ok' });

  const result = await watcherMod.pruneMissing([root]);
  assert.equal(result.removed, 1);
  assert.ok(!fileRow(db, inside), 'vanished file under root still indexed');
  assert.ok(fileRow(db, outside), 'file outside root was pruned');
  assert.ok(fileRow(db, real), 'existing file under root was pruned');
});