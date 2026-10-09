import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function withIndex(t, roots = []) {
  const root = await mkdtemp(join(tmpdir(), 'nx-purge-'));
  const dbFile = join(root, 'index.db');
  process.env.NX_SEARCH_DB = dbFile;
  
  // Create a config file for the scanner
  const config = {
    roots: roots.length > 0 ? roots : [root],
    secret_exclude_patterns: ['*.secret'],
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
  t.after(async () => {
    dbMod.closeDb(dbFile);
    await rm(root, { recursive: true, force: true });
  });
  const db = dbMod.openDb();
  return { db, dbMod, root };
}

test('purge-unsafe removes files matching secret patterns', async (t) => {
  const { db, dbMod, root } = await withIndex(t);
  
  // Create a file with a secret pattern in the path
  const secretFile = join(root, 'test.secret');
  await import('node:fs/promises').then(fs => fs.writeFile(secretFile, 'secret data'));
  
  // Also create a normal file
  const normalFile = join(root, 'normal.txt');
  await import('node:fs/promises').then(fs => fs.writeFile(normalFile, 'normal data'));
  
  // Scan the root to index files
  const { scan } = await import('../lib/scanner.js');
  await scan([root], { rebuild: true });
  
  // Check that both files are indexed
  const totalBefore = db.prepare('SELECT COUNT(*) FROM files').get().c;
  assert.ok(totalBefore > 0, 'Files should be indexed');
  
  // Run purge-unsafe
  const result = dbMod.purgeUnsafe(db);
  assert.equal(result.deleted, 1, 'Should delete one file matching secret pattern');
  
  // Check that secret file is removed
  const secretRow = db.prepare('SELECT * FROM files WHERE path = ?').get(secretFile);
  assert.ok(!secretRow, 'Secret file should be removed from index');
  
  // Check that normal file remains
  const normalRow = db.prepare('SELECT * FROM files WHERE path = ?').get(normalFile);
  assert.ok(normalRow, 'Normal file should remain indexed');
  
  // Also check that content for secret file is removed
  const contentRows = db.prepare('SELECT * FROM content').all();
  const hasSecretContent = contentRows.some(row => row.path === secretFile);
  assert.ok(!hasSecretContent, 'Content for secret file should be removed');
});