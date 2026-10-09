import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { bodyOf, indexedPaths, makeEnv, put } from './helpers.js';

async function indexer(env) {
  const { createPathIndexer } = await import('../lib/watcher.js');
  const { getPolicy } = await import('../lib/policy.js');
  const events = [];
  const db = env.db.openDb();
  return { db, events, update: createPathIndexer({ db, policy: getPolicy({ requireRoots: true }), onEvent: (e) => events.push(e) }) };
}

test('the live watcher applies the same policy as scan', async (t) => {
  const env = await makeEnv(t);
  const { update, events } = await indexer(env);
  await put(env.root, '.gitignore', 'out\n');
  for (const rel of ['prod.env', 'id_ed25519', 'ID_RSA', 'secrets/notes.txt', '.ssh/config', 'out/a.txt']) {
    await update(await put(env.root, rel, 'API_KEY=sk-LIVE0123456789ABCDEF'));
  }
  await put(env.base, 'outside/a.txt', 'x');
  await update(join(env.base, 'outside', 'a.txt'));
  assert.deepEqual(indexedPaths(env.db, env.root), []);
  assert.ok(events.every((e) => e.type === 'skip'), JSON.stringify(events.map((e) => [e.type, e.reason])));
});

test('the watcher redacts text before it is stored', async (t) => {
  const env = await makeEnv(t);
  const { update } = await indexer(env);
  await update(await put(env.root, 'notes.txt', 'token sk-ABCDEFGHIJKLMNOP1234567890 here\npassword = hunter2\nplain words'));
  const body = bodyOf(env.db, env.root, 'notes.txt');
  assert.ok(!body.includes('ABCDEFGHIJKLMNOP1234567890') && !body.includes('hunter2'));
  assert.ok(body.includes('plain words'));
});

test('a file that becomes disallowed is removed from the index', async (t) => {
  const env = await makeEnv(t);
  const { db, update } = await indexer(env);
  const full = await put(env.root, 'old.env', 'A=1');
  const { upsertFile, insertBody } = env.db;
  const { id } = upsertFile(db).get({ path: full, volume: 'x', name: 'old.env', ext: '.env', size: 3, mtime: 1, indexedAt: 1, textStatus: 'ok' });
  insertBody(db).run(id, full, 'A=1');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM files').get().c, 1);
  await update(full);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM files').get().c, 0);
});

test('watching a root outside the configuration is refused', async (t) => {
  const env = await makeEnv(t);
  const { getPolicy } = await import('../lib/policy.js');
  assert.throws(() => getPolicy({ requireRoots: true }).resolveRoots([env.base]), { code: 'SCOPE_INVALID' });
});

test('a running watcher judges each event by the current config, not the one it started with', async (t) => {
  const env = await makeEnv(t);
  const { createWatchIndexer } = await import('../lib/watcher.js');
  const { writeFile } = await import('node:fs/promises');
  const db = env.db.openDb();
  const update = createWatchIndexer({ db, onEvent: () => {} }); // the same factory nx watch uses
  const vault = await put(env.root, 'team.vault', 'ordinary text for now');
  const note = await put(env.root, 'note.txt', 'token sk-ABCDEFGHIJKLMNOP1234567890 and pipeline words');
  await update(vault);
  assert.deepEqual(indexedPaths(env.db, env.root), ['team.vault']);
  await writeFile(env.configFile, JSON.stringify({ roots: [env.root], secret_exclude_patterns: ['*.vault'], security: { audit_logging: false, redaction_patterns: ['pipeline words'] } }));
  await update(vault);
  assert.deepEqual(indexedPaths(env.db, env.root), [], 'the newly excluded file is dropped on its next event');
  await update(note);
  const body = bodyOf(env.db, env.root, 'note.txt');
  assert.ok(!body.includes('pipeline words') && !body.includes('ABCDEFGHIJKLMNOP1234567890'), body);
});
