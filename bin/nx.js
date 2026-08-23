#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const p of [join(__dirname, '..', '.env'), join(homedir(), '.config', 'nx-search', '.env')]) {
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}

import { openDb } from '../lib/db.js';
import { scan } from '../lib/scanner.js';

const [, , cmd, ...args] = process.argv;

function usage() {
  console.log(`nx-search — full-text index of all mounted drives + JARVIS

  nx scan [paths...]     index volumes (default: / + both media drives)
      --rebuild          wipe and reindex from scratch
  nx search <query>      search filenames and file contents
      --name-only        only match filenames/paths
      --limit N          max results (default 25)
  nx ask <question>      JARVIS: natural-language answers over your files (local LLM)
      --no-stream        print answer at once
  nx jarvis              interactive chat loop (exit: quit)
  nx describe <img...>   vision: describe image(s) via NVIDIA + HoloRT4D tokens
      --holo             spatial-token path only (no cloud)
      --native           cloud vision only (no tokens)
      --save             store description in the search index
      --q "question"     custom question about the image
  nx remember <k> <v>    teach JARVIS a persistent preference
  nx serve [--port N]    web UI on http://127.0.0.1:7788 (for systemd autostart)
  nx stats               index statistics
  nx reindex <path>      rescan a single path incrementally

LLM providers (auto if unset): NX_LLM=ollama|nvidia|groq|openrouter|gemini
  ollama (default): local & free — server must run: ollama serve
  nvidia: free key at build.nvidia.com — export NVIDIA_API_KEY=...
    (then pick model, e.g. NX_LLM_MODEL=nvidia/llama-3.3-70b-instruct)
  groq/openrouter/gemini: export GROQ_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY`);
}

async function main() {
  if (cmd === 'scan' || cmd === 'reindex') {
    const flags = args.filter((a) => a.startsWith('--'));
    const paths = args.filter((a) => !a.startsWith('--'));
    const rebuild = flags.includes('--rebuild');
    const roots = cmd === 'reindex'
      ? paths
      : paths.length ? paths : undefined;

    let lastPct = -1;
    const result = await scan(roots, {
      rebuild,
      onProgress: (files, texts) => {
        if (files % 5000 !== 0) return;
        process.stdout.write(`\r  scanned ${files.toLocaleString()} files, ${texts.toLocaleString()} text-extracted `);
        lastPct = files;
      },
    });
    process.stdout.write('\n');
    console.log(`  done: ${result.filesSeen.toLocaleString()} files, ${result.textIndexed.toLocaleString()} searchable bodies in ${result.elapsed}s`);
    console.log(`  index: ${result.dbPath}`);
    return;
  }

  if (cmd === 'describe') {
    const { describeFull, visionDescribe, holoTokensForImage } = await import('../lib/vision.js');
    const flags = args.filter((a) => a.startsWith('--'));
    const files = args.filter((a) => !a.startsWith('--'));
    const qIdx = args.indexOf('--q');
    const question = qIdx !== -1 ? args[qIdx + 1] : undefined;
    const save = flags.includes('--save');
    const holoOnly = flags.includes('--holo');
    const nativeOnly = flags.includes('--native');

    if (!files.length || files[0] === undefined) { usage(); process.exit(1); }

    for (const img of files) {
      process.stdout.write(`\n${img}\n`);
      try {
        let text;
        if (holoOnly) {
          const t = await holoTokensForImage(img);
          text = `${t.text}`;
        } else if (nativeOnly) {
          text = await visionDescribe(img, question);
        } else {
          text = await describeFull(img, { question });
        }
        console.log(text);

        if (save) {
          const db = openDb();
          const row = db.prepare('SELECT id, path FROM files WHERE path = ?').get(img.startsWith('/') ? img : `${process.cwd()}/${img}`);
          if (row) {
            const { replaceBody, insertBody } = await import('../lib/db.js');
            replaceBody(db).run(row.id);
            insertBody(db).run(row.id, row.path, `IMAGE DESCRIPTION: ${text.slice(0, 90_000)}`);
            db.prepare("UPDATE files SET text_status='described' WHERE id = ?").run(row.id);
            console.log('  [saved to index — now searchable]');
          } else {
            console.log('  [not in index; run scan first to save descriptions]');
          }
        }
      } catch (err) {
        console.error(`  error: ${err.message}`);
      }
    }
    return;
  }

  if (cmd === 'serve') {
    const { startServe } = await import('../lib/serve.js');
    const pIdx = args.indexOf('--port');
    startServe(pIdx !== -1 ? parseInt(args[pIdx + 1], 10) : undefined);
    return;
  }

  if (cmd === 'remember') {
    const { remember, forget, loadMemory } = await import('../lib/amul.js');
    if (args[0] === '--forget' && args[1]) {
      forget(args[1]);
      console.log(`forgot: ${args[1]}`);
      return;
    }
    if (args.length < 2) { usage(); process.exit(1); }
    remember(args[0], args.slice(1).join(' '));
    console.log('memory:', JSON.stringify(loadMemory(), null, 2));
    return;
  }

  if (cmd === 'ask' || cmd === 'jarvis') {
    const { runJarvis } = await import('../lib/jarvis.js');

    async function answerOnce(question) {
      process.stdout.write('\nJARVIS: ');
      const { answer, citations, meta } = await runJarvis(question, {
        onToken: (t) => process.stdout.write(t),
      });
      process.stdout.write('\n');
      if (citations.length) {
        console.log('\n' + citations.map((c) => `  ${c}`).join('\n'));
      }
      console.log(`\n  [${meta.mode} · ${meta.provider} · ${(meta.durationMs / 1000).toFixed(1)}s · evidence: ${meta.evidenceCount}]`);
    }

    if (cmd === 'ask') {
      const question = args.filter((a) => !a.startsWith('--')).join(' ');
      if (!question) { usage(); process.exit(1); }
      await answerOnce(question);
      return;
    }

    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('JARVIS online. Ask about anything on your drives. (quit to exit)');
    for (;;) {
      let q = '';
      try {
        q = (await rl.question('\nyou> ')).trim();
      } catch {
        break;
      }
      if (!q || ['quit', 'exit', 'q'].includes(q.toLowerCase())) break;
      try {
        await answerOnce(q);
      } catch (err) {
        console.error(`\n[llm error] ${err.message}`);
      }
    }
    rl.close();
    return;
  }

  if (cmd === 'search') {
    const nameOnly = args.includes('--name-only');
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) || 25 : 25;
    const skip = new Set(limitIdx === -1 ? [] : [limitIdx, limitIdx + 1]);
    const q = args
      .filter((a, i) => !skip.has(i) && !a.startsWith('--'))
      .join(' ');
    if (!q) { usage(); process.exit(1); }

    const db = openDb();
    const safe = q.replace(/"/g, '""');

    if (!nameOnly) {
      const hits = db.prepare(`
        SELECT path, snippet(content, 1, '\u001b[33m', '\u001b[0m', ' … ', 14) AS snip,
               bm25(content) AS rank
        FROM content WHERE content MATCH ?
        ORDER BY rank LIMIT ?
      `).all(`"${safe}"`, limit);

      if (hits.length) {
        console.log(`\ncontent matches (${hits.length}):`);
        for (const h of hits) {
          const rel = h.path.length > 90 ? '…' + h.path.slice(-89) : h.path;
          console.log(`  ${rel}`);
          console.log(`    ${h.snip.replace(/\s+/g, ' ').slice(0, 160)}`);
        }
      } else {
        console.log('no content matches');
      }
    }

    const tokens = q.trim().split(/\s+/).filter(Boolean);
    const where = tokens.map(() => 'path LIKE ?').join(' AND ');
    const params = [...tokens.map((t) => `%${t}%`), limit];
    const nameHits = db.prepare(`
      SELECT path, size FROM files
      WHERE ${where}
      ORDER BY mtime DESC LIMIT ?
    `).all(...params);

    if (nameHits.length) {
      console.log(`\nfilename matches (${nameHits.length}):`);
      for (const h of nameHits) {
        const rel = h.path.length > 90 ? '…' + h.path.slice(-89) : h.path;
        console.log(`  ${rel}  (${fmtSize(h.size)})`);
      }
    }
    return;
  }

  if (cmd === 'stats') {
    const db = openDb();
    const total = db.prepare('SELECT COUNT(*) c FROM files').get().c;
    const withText = db.prepare("SELECT COUNT(*) c FROM files WHERE text_status='ok'").get().c;
    const bytes = db.prepare('SELECT SUM(size) s FROM files').get().s || 0;
    const byVolume = db.prepare(`
      SELECT volume, COUNT(*) c, SUM(size) s FROM files GROUP BY volume ORDER BY c DESC
    `).all();
    const topExt = db.prepare(`
      SELECT ext, COUNT(*) c FROM files WHERE ext != '' GROUP BY ext ORDER BY c DESC LIMIT 12
    `).all();
    console.log(`indexed files: ${total.toLocaleString()} (${fmtSize(bytes)})`);
    console.log(`full-text bodies: ${withText.toLocaleString()}`);
    console.log('\nby volume:');
    for (const v of byVolume) console.log(`  ${v.volume.padEnd(30)} ${v.c.toLocaleString().padStart(9)} files  ${fmtSize(v.s || 0)}`);
    console.log('\ntop extensions:');
    console.log('  ' + topExt.map((e) => `${e.ext || '(none)'}:${e.c.toLocaleString()}`).join('  '));
    return;
  }

  usage();
  process.exit(cmd ? 1 : 0);
}

function fmtSize(n) {
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n > 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n + ' B';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
