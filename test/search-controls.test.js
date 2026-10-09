import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { makeEnv, put } from './helpers.js';

async function seed(env, count = 8) {
  for (let i = 0; i < count; i += 1) await put(env.root, `doc${i}.txt`, `alpha beta ${i}`);
  const { scan } = await import('../lib/scanner.js');
  await scan(undefined, {});
}

const auditOps = async (env) => (await readFile(env.auditFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

test('the configured result cap and rate limit are enforced (the config is actually loaded)', async (t) => {
  const env = await makeEnv(t, { security: { search_result_cap: 3, rate_limit_qpm: 2 } });
  await seed(env);
  const { searchIndex } = env.search;
  assert.equal(searchIndex('alpha', { limit: 10, caller: 'a' }).content.length, 3);
  assert.equal(searchIndex('alpha', { limit: 10, caller: 'a' }).content.length, 3);
  assert.equal(searchIndex('alpha', { limit: 10, caller: 'a' }).error, 'RATE_LIMITED');
  assert.equal(searchIndex('alpha', { limit: 10, caller: 'b' }).error, undefined, 'another caller has its own budget');
});

test('every search is audited, as a hash by default', async (t) => {
  const env = await makeEnv(t);
  await seed(env, 2);
  env.search.searchIndex('alpha secret-thing', { caller: 'cli' });
  env.search.searchIndex('beta', { caller: 'mcp' });
  const entries = (await auditOps(env)).filter((e) => e.op === 'search');
  assert.deepEqual(entries.map((e) => e.caller), ['cli', 'mcp']);
  assert.match(entries[0].queryHash, /^[0-9a-f]{64}$/);
  assert.equal(entries[0].queryLength, 'alpha secret-thing'.length);
  assert.equal('query' in entries[0], false, 'the query text is not stored unless asked for');
  assert.ok((await auditOps(env)).some((e) => e.op === 'scan'));
});

test('audit_log_queries stores the text, and audit_logging false stores nothing', async (t) => {
  const env = await makeEnv(t, { security: { audit_log_queries: true } });
  await seed(env, 1);
  env.search.searchIndex('alpha', { caller: 'cli' });
  assert.equal((await auditOps(env)).find((e) => e.op === 'search').query, 'alpha');
});

test('with audit_logging false nothing is written', async (t) => {
  const env = await makeEnv(t, { security: { audit_logging: false } });
  await seed(env, 1);
  env.search.searchIndex('alpha');
  await assert.rejects(readFile(env.auditFile), { code: 'ENOENT' });
});

test('snippets are redacted on the way out, even for rows indexed before the policy existed', async (t) => {
  const env = await makeEnv(t);
  const db = env.db.openDb();
  const { id } = env.db.upsertFile(db).get({ path: `${env.root}/old.txt`, volume: 'x', name: 'old.txt', ext: '.txt', size: 1, mtime: 1, indexedAt: 1, textStatus: 'ok' });
  env.db.insertBody(db).run(id, `${env.root}/old.txt`, 'deploy token sk-ABCDEFGHIJKLMNOP1234567890 for the pipeline');
  const hit = env.search.searchIndex('pipeline').content[0];
  assert.ok(hit.snippet.includes('[REDACTED]') && !hit.snippet.includes('ABCDEFGHIJKLMNOP1234567890'), hit.snippet);
});

test('retrieval for the LLM redacts too', async (t) => {
  const env = await makeEnv(t);
  const db = env.db.openDb();
  const { id } = env.db.upsertFile(db).get({ path: `${env.root}/old.txt`, volume: 'x', name: 'old.txt', ext: '.txt', size: 1, mtime: 1, indexedAt: 1, textStatus: 'ok' });
  env.db.insertBody(db).run(id, `${env.root}/old.txt`, 'staging password = hunter2 documented here');
  const { retrieve } = await import('../lib/rag.js');
  const text = retrieve('staging documented').chunks.map((c) => c.text).join(' ');
  assert.ok(text.includes('staging') && !text.includes('hunter2'), text);
});

test('security.encryption true refuses to open the index instead of opening it in the clear', async (t) => {
  const env = await makeEnv(t, { security: { encryption: true } });
  env.db.closeDb(env.dbFile);
  assert.throws(() => env.db.openDb(), { code: 'ENCRYPTION_UNSUPPORTED' });
});

test('an invalid config stops a search instead of disabling the limits', async (t) => {
  const env = await makeEnv(t);
  await put(env.base, 'config.json', '{ broken');
  assert.throws(() => env.search.searchIndex('alpha'), { code: 'CONFIG_INVALID' });
});
