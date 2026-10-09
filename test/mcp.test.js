import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('MCP adapter initializes, lists tools, and returns search evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nx-mcp-'));
  const dbFile = join(root, 'index.db');
  process.env.NX_SEARCH_DB = dbFile;
  process.env.NX_SEARCH_CONFIG = join(root, 'absent.json');
  process.env.NX_AUDIT_LOG = join(root, 'audit.log');
  process.env.JARVIS_NX_ENABLED = '1';
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


test('the MCP bridge is off unless JARVIS_NX_ENABLED=1, and says so', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nx-mcp-off-'));
  process.env.NX_SEARCH_DB = join(root, 'index.db');
  process.env.NX_SEARCH_CONFIG = join(root, 'absent.json');
  delete process.env.JARVIS_NX_ENABLED;
  const { handleMcpMessage } = await import('../lib/mcp.js');
  t.after(() => rm(root, { recursive: true, force: true }));
  const init = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result, undefined);
  assert.equal(init.error.code, -32001);
  assert.match(init.error.message, /JARVIS_NX_ENABLED=1/);
  process.env.JARVIS_NX_ENABLED = '1';
  const on = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(on.result.serverInfo.name, 'nx-search');
  const unknown = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nx_scan', arguments: {} } });
  assert.equal(unknown.result.isError, true);
  delete process.env.JARVIS_NX_ENABLED;
});
