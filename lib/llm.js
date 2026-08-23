const OLLAMA = process.env.NX_OLLAMA_URL || 'http://localhost:11434';

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const KEYCHAIN_PATHS = [
  process.env.NX_KEYCHAIN,
  homedir() + '/.config/nx-search/keys.json',
].filter(Boolean);

let _keychain = null;
function keychain() {
  if (_keychain !== null) return _keychain;
  _keychain = {};
  for (const path of KEYCHAIN_PATHS) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      for (const [provider, entry] of Object.entries(raw)) {
        _keychain[provider] =
          typeof entry === 'string' ? { api_key: entry } : { ...entry };
      }
    } catch {}
  }
  return _keychain;
}

function keyFor(provider, envName) {
  return keychain()[provider]?.api_key || process.env[envName] || '';
}

function baseUrlFor(provider, fallbackBase, envName) {
  return (
    keychain()[provider]?.base_url ||
    process.env[envName] ||
    fallbackBase
  );
}

// Route a bare model id to the provider that serves it.
// Explicit "provider:model" always wins.
export function resolveRoute(model, forcedProvider) {
  const raw = String(model || '').trim();
  const explicit = raw.match(/^([a-z0-9_]+):(.+)$/i);
  if (explicit && PROVIDER_ROUTES[explicit[1]]) {
    return { provider: explicit[1], model: explicit[2] };
  }
  if (forcedProvider && PROVIDER_ROUTES[forcedProvider]) {
    return { provider: forcedProvider, model: raw };
  }
  for (const [provider, rule] of Object.entries(PROVIDER_ROUTES)) {
    if (!rule.match) continue;
    if (rule.match.some((re) => re.test(raw))) {
      return { provider, model: raw };
    }
  }
  return null;
}

const PROVIDER_ROUTES = {
  nvidia: {
    match: [/^meta\//, /^nvidia\//, /^deepseek-ai\//, /^google\/gemma/, /^microsoft\/phi/],
    key_env: 'NVIDIA_API_KEY',
    base: 'https://integrate.api.nvidia.com/v1',
    default_model: 'meta/muse-glimmer-30b',
  },

  groq: {
    match: [/^groq\//],
    key_env: 'GROQ_API_KEY',
    base: 'https://api.groq.com/openai/v1',
    default_model: 'llama-3.3-70b-versatile',
  },
  oxalpha: {
    match: [/^stealth\//],
    key_env: 'TOKENRA_API_KEY',
    base: 'https://tokenra.io/v1',
    default_model: 'stealth/ox-alpha',
  },
};

export function activeProvider() {
  if (process.env.NX_LLM && process.env.NX_LLM !== 'auto') return process.env.NX_LLM;
  if (process.env.NVIDIA_API_KEY) return 'nvidia';
  if (process.env.TOKENRA_API_KEY) return 'oxalpha';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'ollama';
}

async function withTimeout(fetchPromise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms}s`)), ms); });
  try {
    return await Promise.race([fetchPromise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function chatOllama(messages, opts) {
  const res = await withTimeout(fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.NX_OLLAMA_MODEL || 'qwen2.5:3b', messages, stream: true, options: { temperature: opts.temperature ?? 0.2, num_ctx: 4096 } }),
  }), opts.timeoutMs ?? 300_000);
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  let full = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.message?.content) {
          full += j.message.content;
          if (opts.onToken) opts.onToken(j.message.content);
        }
      } catch {}
    }
  }
  return full.trim();
}

async function chatOpenAICompatible(messages, opts, baseUrl, keyEnv, modelDefault, extras = {}) {
  const key = opts.apiKey || process.env[keyEnv];
  if (!key) throw new Error(`${keyEnv} not set`);
  const model = opts.model || process.env.NX_LLM_MODEL || modelDefault;
  const res = await withTimeout(fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      stream: true,
      ...extras,
    }),
  }), opts.timeoutMs ?? 120_000);
  if (!res.ok) throw new Error(`${keyEnv} provider ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let full = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          if (opts.onToken) opts.onToken(delta);
        }
      } catch {}
    }
  }
  return full.trim();
}

const PROVIDERS = {
  ollama: chatOllama,
  oxalpha: async (messages, opts) => {
    const raw = await chatOpenAICompatible(messages, opts, 'https://tokenra.io/v1', 'TOKENRA_API_KEY', 'stealth/ox-alpha');
    const content = typeof raw === 'string' ? raw.trim() : '';
    if (!content) throw new Error('Tokenra returned no displayable completion');
    return content;
  },
  groq: (m, o) => chatOpenAICompatible(m, o, 'https://api.groq.com/openai/v1', 'GROQ_API_KEY', 'llama-3.3-70b-versatile'),
  openrouter: (m, o) => chatOpenAICompatible(m, o, 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY', 'meta-llama/llama-3.3-70b-instruct:free'),
  nvidia: (m, o) => chatOpenAICompatible(m, o, 'https://integrate.api.nvidia.com/v1', 'NVIDIA_API_KEY', 'meta/muse-glimmer-30b', {
    max_tokens: Number(process.env.NX_MAX_OUTPUT_TOKENS) || 4096,
    chat_template_kwargs: {
      enable_thinking: o.reasoningEffort ? true : process.env.NX_NVIDIA_THINKING === '1',
      ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}),
    },
  }),
  gemini: async (messages, opts) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not set');
    const model = process.env.NX_LLM_MODEL || 'gemini-2.0-flash';
    const res = await withTimeout(fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          systemInstruction: { parts: [{ text: messages.find((m) => m.role === 'system')?.content || '' }] },
          generationConfig: { temperature: opts.temperature ?? 0.2 },
        }),
      }), opts.timeoutMs ?? 120_000);
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    let full = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const j = JSON.parse(line.slice(5));
          const t = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
          if (t) {
            full += t;
            if (opts.onToken) opts.onToken(t);
          }
        } catch {}
      }
    }
    return full.trim();
  },
};

export async function chat(messages, opts = {}) {
  // Model-aware routing: bare model ids resolve to the provider whose
  // keychain entry (or env key) can serve them. "provider:model" overrides.
  const routeCandidate = opts.model || process.env.NX_LLM_MODEL || '';
  const route = resolveRoute(routeCandidate, opts.forceProvider);
  if (route) {
    const rule = PROVIDER_ROUTES[route.provider];
    const apiKey = keyFor(route.provider, rule.key_env);
    if (apiKey) {
      return chatOpenAICompatible(
        messages,
        { ...opts, model: route.model, apiKey },
        baseUrlFor(route.provider, rule.base),
        rule.key_env,
        rule.default_model,
      );
    }
    if (!process.env.NX_NO_FALLBACK && !opts._retried) {
      console.error(`[nx: no ${route.provider} key — falling back to local ollama]`);
      return PROVIDERS.ollama(messages, { ...opts, _retried: true });
    }
    throw new Error(`${route.provider} key missing for model ${route.model}`);
  }

  const name = opts.forceProvider || activeProvider();
  const fn = PROVIDERS[name];
  if (!fn) throw new Error(`unknown NX_LLM provider: ${name} (options: ${Object.keys(PROVIDERS).join(', ')})`);
  try {
    return await fn(messages, opts);
  } catch (err) {
    if (name === 'ollama' || process.env.NX_NO_FALLBACK) throw err;
    if (!opts._retried) {
      console.error(`\n[nx: ${name} unavailable (${err.message}) — falling back to local ollama]`);
      return PROVIDERS.ollama(messages, { ...opts, _retried: true });
    }
    throw err;
  }
}
