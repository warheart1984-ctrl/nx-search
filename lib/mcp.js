import readline from 'node:readline';
import { indexStats, searchIndex } from './search.js';
import { openDb, closeDb } from './db.js';
import { loadNxEnv } from './env.js';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const NX_MCP_INFO = { name: 'nx-search', version: '0.1.0' };

// Load configuration
const CONFIG_PATH = process.env.NX_SEARCH_CONFIG || join(homedir(), '.local', 'share', 'nx-search', '.nx-search-config.json');
let config = { security: { search_result_cap: 50, rate_limit_qpm: 60, audit_logging: true } };
try {
  const cfgRaw = require(CONFIG_PATH);
  config = { ...config, ...cfgRaw, security: { ...config.security, ...cfgRaw.security } };
} catch (e) {
  // Use defaults
}

// Feature flags from environment
const JARVIS_NX_ENABLED = process.env.JARVIS_NX_ENABLED === '1';
const JARVIS_NX_WRITE_ENABLED = process.env.JARVIS_NX_WRITE_ENABLED === '1';

// Rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function checkRateLimit(caller) {
  const now = Date.now();
  const key = typeof caller === 'string' ? caller : 'default';
  const calls = rateLimitMap.get(key) || [];
  const recent = calls.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= config.security.rate_limit_qpm) {
    return false;
  }
  calls.push(now);
  rateLimitMap.set(key, calls);
  return true;
}

function auditLog(op, query, caller) {
  if (!config.security.audit_logging) return;
  try {
    const auditLog = join(homedir(), '.local', 'share', 'nx-search', 'audit.log');
    const fs = require('fs');
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      caller: caller,
      op: op,
      query: query,
      queryHash: require('crypto').createHash('sha256').update(query).digest('hex'),
      userAgent: process.env.USER_AGENT || 'unknown'
    }) + '\n';
    fs.writeFileSync(auditLog, logEntry, { flag: 'a' });
  } catch (e) {
    // Ignore audit failures
  }
}

const SUPPORTED_PROTOCOL = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
];

export const NX_MCP_TOOLS = [
  {
    name: 'nx_search',
    description:
      'Search indexed local drives by filename and file contents via nx-search. Use this instead of recursive directory walks when the user wants to find files, documents, notes, or text on their PC.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search string. Matched as a content phrase and as filename/path tokens.',
        },
        name_only: {
          type: 'boolean',
          description: 'If true, only match filenames/paths (skip full-text content).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Max hits per result set (default 25).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'nx_stats',
    description:
      'Show nx-search index health: file counts, full-text coverage, volumes, and top extensions. Use when checking whether the drive index exists or is empty.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

export async function handleMcpMessage(msg) {
  if (Array.isArray(msg)) {
    const replies = [];
    for (const item of msg) {
      const reply = await handleMcpMessage(item);
      if (reply) replies.push(reply);
    }
    return replies;
  }
  if (!msg || typeof msg !== 'object') return null;

  const { id, method, params } = msg;
  if (!method) return jsonError(id, -32600, 'Invalid request');

  // Feature flag check
  if (!JARVIS_NX_ENABLED) {
    return jsonError(id, 1, 'NX_DISABLED: nx-search bridge is disabled');
  }

  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL.includes(requested) ? requested : '2025-03-26';
    return jsonResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: NX_MCP_INFO,
      instructions:
        'Search the user\'s indexed local drives with nx_search. Call nx_stats if the index looks empty. Do not use this adapter for Jarvis/LLM answers — it is evidence (paths + snippets) only.',
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null;
  }
  if (method === 'ping') return jsonResult(id, {});
  if (method === 'logging/setLevel') return jsonResult(id, {});

  if (method === 'tools/list') {
    return jsonResult(id, { tools: NX_MCP_TOOLS });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    if (!name) return jsonError(id, -32602, 'Missing tool name');
    
    // Auth check for write operations
    if (!JARVIS_NX_WRITE_ENABLED && ['nx_scan', 'nx_reindex', 'nx_prune', 'nx_watch'].includes(name)) {
      return jsonError(id, 2, 'AUTHORITY_DENIED: Write operations disabled');
    }

    try {
      if (name === 'nx_search') {
        const query = params?.arguments?.query || '';
        const nameOnly = params?.arguments?.name_only || false;
        const limit = params?.arguments?.limit || 25;
        
        // Rate limiting
        if (!checkRateLimit('mcp')) {
          return jsonResult(id, toolText({ error: 'RATE_LIMITED' }, true));
        }

        const data = searchIndex(query, {
          nameOnly,
          limit,
          highlight: false,
          caller: 'mcp',
        });
        
        // Response redaction
        if (data.content) {
          for (let hit of data.content) {
            hit.snippet = redactSnippet(hit.snippet);
          }
        }
        
        await auditLog('search', query, 'mcp');
        return jsonResult(id, toolText(data, Boolean(data.error)));
      }
      
      if (name === 'nx_stats') {
        const data = indexStats();
        await auditLog('stats', '', 'mcp');
        return jsonResult(id, toolText(data));
      }
      
      return jsonResult(id, toolText({ error: `unknown tool: ${name}` }, true));
    } catch (err) {
      return jsonResult(id, toolText({ error: err.message }, true));
    }
  }

  if (id === undefined) return null;
  return jsonError(id, -32601, `Method not found: ${method}`);
}

export async function startMcpStdio() {
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write('nx-mcp: ignored malformed JSON line\n');
      continue;
    }
    try {
      const reply = await handleMcpMessage(msg);
      if (reply == null) continue;
      const payload = Array.isArray(reply) ? reply : [reply];
      for (const item of payload) {
        process.stdout.write(JSON.stringify(item) + '\n');
      }
    } catch (err) {
      process.stderr.write(`nx-mcp: ${err.message}\n`);
      if (msg?.id !== undefined) {
        process.stdout.write(JSON.stringify(jsonError(msg.id, -32603, err.message)) + '\n');
      }
    }
  }
}

function toolText(data, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError,
  };
}

function jsonResult(id, result) {
  if (id === undefined) return null;
  return { jsonrpc: '2.0', id, result };
}

function jsonError(id, code, message) {
  if (id === undefined) return null;
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// Helper function for response redaction
function redactSnippet(snippet) {
  // Simple redaction - would need patterns from config
  return snippet.replace(/(password\s*[:=]\s*\S+)/gi, '[REDACTED]');
}