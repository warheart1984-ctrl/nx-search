import readline from 'node:readline';
import { indexStats, searchIndex } from './search.js';

export const NX_MCP_INFO = { name: 'nx-search', version: '0.1.0' };

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
    const args = params?.arguments || {};
    try {
      if (name === 'nx_search') {
        const data = searchIndex(args.query, {
          nameOnly: Boolean(args.name_only),
          limit: args.limit,
        });
        return jsonResult(id, toolText(data, Boolean(data.error)));
      }
      if (name === 'nx_stats') {
        return jsonResult(id, toolText(indexStats()));
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
