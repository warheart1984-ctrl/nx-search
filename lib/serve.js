import http from 'node:http';
import { runJarvis } from './jarvis.js';

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JARVIS — nx-search</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: 'Ubuntu', system-ui, sans-serif;
    background: radial-gradient(1200px 800px at 70% -10%, #1b1035 0%, #0a0a14 55%, #050508 100%);
    color: #dcdce6; min-height: 100vh; display: flex; flex-direction: column;
  }
  header { padding: 18px 24px; border-bottom: 1px solid #221c3a; display:flex; align-items:center; gap:12px; }
  header .orb { width:14px; height:14px; border-radius:50%; background:#7c5cff; box-shadow:0 0 18px #7c5cff; animation:pulse 2.4s infinite; }
  @keyframes pulse { 0%,100%{opacity:.7} 50%{opacity:1} }
  h1 { font-size: 15px; font-weight: 500; letter-spacing: 3px; color:#b9a8ff; text-transform:uppercase; }
  #log { flex:1; overflow-y:auto; padding: 24px; display:flex; flex-direction:column; gap:16px; max-width: 980px; margin: 0 auto; width:100%; }
  .msg { line-height:1.55; white-space:pre-wrap; word-break:break-word; }
  .you { color:#8f8fa3; } .you::before{ content:'you ▸ '; color:#565668; }
  .jarvis { color:#e6e1ff; } .jarvis::before{ content:'JARVIS ▸ '; color:#7c5cff; }
  .meta { font-size:11.5px; color:#5f5f78; margin-top:6px; }
  .cite { font-size:11.5px; color:#6f6f92; margin-top:6px; }
  .cite a { color:#9d8cff; text-decoration:none; }
  #bar { display:flex; gap:10px; padding: 16px 24px 22px; max-width:980px; margin:0 auto; width:100%; }
  #q { flex:1; background:#12101f; border:1px solid #2c2547; color:#eee; border-radius:10px; padding:13px 16px; font-size:14px; outline:none; }
  #q:focus { border-color:#7c5cff; box-shadow:0 0 0 3px rgba(124,92,255,.15); }
  button { background:#7c5cff; border:none; color:white; border-radius:10px; padding:0 22px; font-size:14px; cursor:pointer; }
  button:disabled { opacity:.5; }
</style>
</head>
<body>
<header><div class="orb"></div><h1>Jarvis // nx-search</h1></header>
<div id="log"></div>
<div id="bar">
  <input id="q" placeholder="Ask about anything on your drives…" autofocus />
  <button onclick="send()">Send</button>
</div>
<script>
const log = document.getElementById('log');
const q = document.getElementById('q');
function add(cls, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  log.appendChild(d);
  return d;
}
async function send() {
  const question = q.value.trim();
  if (!question) return;
  q.value = '';
  add('you', question);
  const holder = add('jarvis', '…thinking…');
  try {
    const r = await fetch('/api/ask', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ q: question }) });
    const j = await r.json();
    if (j.error) { holder.textContent = 'error: ' + j.error; return; }
    holder.textContent = j.answer;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = \`\${j.meta.mode} · \${j.meta.provider} · \${(j.meta.durationMs/1000).toFixed(1)}s · evidence: \${j.meta.evidenceCount}\`;
    holder.appendChild(meta);
    if (j.citations && j.citations.length) {
      const c = document.createElement('div');
      c.className = 'cite';
      c.innerHTML = j.citations.map(s => {
        const [n, p] = s.split('] ');
        return \`<a href="file://\${p}" target="_blank">\${n}] \${p.length>70?'…'+p.slice(-69):p}</a>\`;
      }).join('<br>');
      holder.appendChild(c);
    }
  } catch (e) {
    holder.textContent = 'error: ' + e.message;
  }
}
q.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
</script>
</body>
</html>`;

export function startServe(port = Number(process.env.NX_PORT) || 7788) {
  
const _RESULT_CACHE = new Map();
const RESULT_TTL_MS = 30_000;
const RESULT_CACHE_MAX = 200;

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/search')) {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const q = (url.searchParams.get('q') || '').trim();
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '6', 10) || 6, 25);
      if (!q) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'missing q' }));
        return;
      }
      try {
        const key = `s:${q}:${limit}`;
        const now = Date.now();
        const hit = _RESULT_CACHE.get(key);
        let data;
        if (hit && now - hit.ts < RESULT_TTL_MS) {
          data = hit.data;
        } else {
          const { retrieve } = await import('./rag.js');
          const { chunks, pathMatched } = retrieve(q, { perQuery: limit, maxChunks: limit });
          data = {
            query: q,
            results: chunks.map((c) => ({ path: c.path, snippet: c.text.slice(0, 400) })),
            path_hits: pathMatched.slice(0, 5),
          };
          _RESULT_CACHE.set(key, { ts: now, data });
          if (_RESULT_CACHE.size > RESULT_CACHE_MAX) {
            const oldest = _RESULT_CACHE.keys().next().value;
            _RESULT_CACHE.delete(oldest);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ask') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { q } = JSON.parse(body);
        if (!q || typeof q !== 'string') throw new Error('missing q');
        const out = await runJarvis(q);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`JARVIS web UI: http://127.0.0.1:${port}`);
  });
  return server;
}
