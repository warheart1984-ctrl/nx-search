import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function withIndex(t, seed) {
  const root = await mkdtemp(join(tmpdir(), 'nx-adapter-'));
  const dbFile = join(root, 'index.db');
  process.env.NX_SEARCH_DB = dbFile;
  const dbMod = await import('../lib/db.js');
  const searchMod = await import('../lib/search.js');
  t.after(async () => {
    dbMod.closeDb(dbFile);
    await rm(root, { recursive: true, force: true });
  });
  const db = dbMod.openDb();
  await seed(db, dbMod);
  return { ...dbMod, ...searchMod, root };
}

test('searchIndex matches file contents and names', async (t) => {
  const { searchIndex, indexStats } = await withIndex(t, (db, { upsertFile, replaceBody, insertBody }) => {
    const { id } = upsertFile(db).get({
      path: 'G:\\docs\\invoice-2024.txt',
      volume: 'G:',
      name: 'invoice-2024.txt',
      ext: '.txt',
      size: 42,
      mtime: Date.now(),
      indexedAt: Date.now(),
      textStatus: 'ok',
    });
    replaceBody(db).run(id);
    insertBody(db).run(id, 'G:\\docs\\invoice-2024.txt', 'paid the adapter invoice for nx-search wiring');
  });

  const found = searchIndex('adapter invoice', { limit: 10 });
  assert.equal(found.emptyIndex, false);
  assert.ok(found.content.some((hit) => hit.path.includes('invoice-2024')));
  assert.ok(found.content[0].snippet.toLowerCase().includes('adapter'));

  const byName = searchIndex('invoice-2024', { nameOnly: true });
  assert.ok(byName.filenames.some((hit) => hit.path.includes('invoice-2024')));

  const stats = indexStats();
  assert.equal(stats.indexedFiles, 1);
  assert.equal(stats.fullTextBodies, 1);
  assert.equal(stats.byVolume[0].volume, 'G:');
});

test('searchIndex reports an empty index instead of pretending to search', async (t) => {
  const { searchIndex } = await withIndex(t, () => {});
  const found = searchIndex('anything at all');
  assert.equal(found.emptyIndex, true);
  assert.equal(found.content.length, 0);
  assert.match(found.hint, /nx scan/);
});
