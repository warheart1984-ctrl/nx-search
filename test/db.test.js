import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { makeEnv, put } from './helpers.js';

function addRow(env, db, path, body) {
  const { id } = env.db.upsertFile(db).get({ path, volume: 'x', name: path.split(/[\\/]/).pop(), ext: '.txt', size: 1, mtime: 1, indexedAt: 1, textStatus: 'ok' });
  env.db.insertBody(db).run(id, path, body);
}

async function seedUnsafe(env) {
  await put(env.root, '.gitignore', '*.log\n');
  const db = env.db.openDb();
  addRow(env, db, join(env.root, 'server.pem'), 'PRIVATE BODY ONE');
  addRow(env, db, join(env.root, 'a', 'prod.env'), 'API=two');
  addRow(env, db, join(env.root, 'MY-SECRET.txt'), 'three');
  addRow(env, db, join(env.root, 'secrets', 'n.txt'), 'four');
  addRow(env, db, join(env.root, 'debug.log'), 'five');
  addRow(env, db, join(env.base, 'elsewhere', 'x.txt'), 'six');
  addRow(env, db, join(env.root, 'ok', 'readme.txt'), 'plain text about deploys');
  addRow(env, db, join(env.root, 'ok', 'deploy.txt'), 'deploy key sk-ABCDEFGHIJKLMNOP1234567890 inside');
  return db;
}

test('purge-unsafe removes rows the policy does not allow and redacts stored secrets', async (t) => {
  const env = await makeEnv(t);
  const db = await seedUnsafe(env);
  const { purgeUnsafe } = await import('../lib/purge.js');
  const result = purgeUnsafe(db);
  assert.equal(result.deleted, 6);
  assert.deepEqual(result.reasons, { 'secret-file': 3, 'denied-directory': 1, gitignored: 1, 'outside-roots': 1 });
  assert.equal(result.redacted, 1);
  assert.equal(result.total, 2);
  assert.equal(result.compacted, true);
  assert.deepEqual(db.prepare('SELECT path FROM files ORDER BY path').all().map((r) => r.path.slice(env.root.length + 1).split('\\').join('/')), ['ok/deploy.txt', 'ok/readme.txt']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM content').get().c, 2);
  const stored = db.prepare("SELECT body FROM content WHERE path LIKE '%deploy.txt'").get().body;
  assert.ok(stored.includes('[REDACTED]') && !stored.includes('ABCDEFGHIJKLMNOP1234567890'));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM content WHERE content MATCH 'PRIVATE'").get().c, 0, 'the removed text is no longer searchable');
});

test('purge-unsafe --dry-run reports and changes nothing', async (t) => {
  const env = await makeEnv(t);
  const db = await seedUnsafe(env);
  const { purgeUnsafe } = await import('../lib/purge.js');
  const result = purgeUnsafe(db, { dryRun: true });
  assert.equal(result.deleted, 6);
  assert.equal(result.redacted, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM files').get().c, 8);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM content WHERE content MATCH 'PRIVATE'").get().c, 1);
});

test('purge-unsafe on a clean index does nothing', async (t) => {
  const env = await makeEnv(t);
  const db = env.db.openDb();
  addRow(env, db, join(env.root, 'ok', 'readme.txt'), 'plain text');
  const { purgeUnsafe } = await import('../lib/purge.js');
  assert.deepEqual(purgeUnsafe(db), { total: 1, deleted: 0, redacted: 0, reasons: {}, compacted: false, dryRun: false });
});
