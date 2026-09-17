import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('MCP adapter initializes, lists tools, and returns search evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nx-mcp-'));
  const dbFile = join(root, 'index.db');
  process.env.NX_SEARCH_DB = dbFile;
  const { openDb, closeDb, upsertFile, replaceBody, insertBody } = await import('../lib/db.js');
  const { handleMcpMessage, NX_MCP_TOOLS } = await import('../lib/mcp.js');
  t.after(async () => {
    closeDb(dbFile);
    await rm(root, { recursive: true, force: true });
  });

  const db = openDb();
  const { id } = upsertFile(db).get({
    path: 'C:\\Users\\randj\\notes\\drive-search.md',
    volume: 'C:',
    name: 'drive-search.md',
    ext: '.md',
    size: 20,
    mtime: Date.now(),
    indexedAt: Date.now(),
    textStatus: 'ok',
  });
  replaceBody(db).run(id);
  insertBody(db).run(id, 'C:\\Users\\randj\\notes\\drive-search.md', 'nx adapter searches indexed drives');

  const init = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  });
  assert.equal(init.result.serverInfo.name, 'nx-search');
  assert.equal(init.result.protocolVersion, '2025-03-26');

  const listed = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name).sort(),
    NX_MCP_TOOLS.map((tool) => tool.name).sort(),
  );

  const called = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'nx_search', arguments: { query: 'adapter' } },
  });
  assert.equal(called.result.isError, false);
  const payload = JSON.parse(called.result.content[0].text);
  assert.ok(payload.content.some((hit) => hit.path.includes('drive-search.md')));

  const stats = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'nx_stats', arguments: {} },
  });
  const statPayload = JSON.parse(stats.result.content[0].text);
  assert.equal(statPayload.indexedFiles, 1);
});
