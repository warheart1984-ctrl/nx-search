#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { loadNxEnv } from '../lib/env.js';
import { openDb } from '../lib/db.js';
import { scan } from '../lib/scanner.js';
import { startMcpStdio } from '../lib/mcp.js';
import { indexStats, searchIndex } from '../lib/search.js';

loadNxEnv();

const [, , cmd, ...args] = process.argv;

function usage() {
  console.log(`nx-search — full-text index of all mounted drives + JARVIS

  nx scan [paths...]     index volumes (Windows default: user profile; Linux: / + media drives)
      --rebuild          wipe and reindex from scratch
  nx search <query>      search filenames and file contents
      --name-only        only match filenames/paths
      --limit N          max results (default 25)
      --json             machine-readable output (MCP/adapter fallback)
  nx mcp                 stdio MCP adapter for Cursor (nx_search / nx_stats)
  nx ask <question>      JARVIS: natural-language answers over your files (local LLM)
      --no-stream        print answer at once
  nx jarvis              interactive chat loop (exit: quit)
  nx describe <img...>   vision: describe image(s) via NVIDIA + HoloRT4D tokens
      --holo             spatial-token path only (no cloud)
      --native           cloud vision only (no tokens)
      --save             store description in the search index
      --q "question"     custom question about the image
  nx spatialize <dir>   spatial + temporal memory for every rendered frame
      --every-nth N     sample every Nth frame (default 1)
      --max-frames N    explicit safety cap (default: no cap)
      --tag TEXT        attach a searchable sequence tag
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
          const abs = isAbsolute(img) ? img : resolve(img);
          const row = db.prepare('SELECT id, path FROM files WHERE path = ?').get(abs);
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

  if (cmd === 'spatialize') {
    const { spatializeDir } = await import('../lib/spatialize.js');
    const valueFlags = new Set(['--every-nth', '--max-frames', '--tag']);
    const targets = [];
    for (let i = 0; i < args.length; i++) {
      if (valueFlags.has(args[i])) {
        i++;
      } else if (!args[i].startsWith('--')) {
        targets.push(args[i]);
      }
    }
    if (!targets.length) { usage(); process.exit(1); }
    const readPositiveInt = (flag, fallback) => {
      const index = args.indexOf(flag);
      if (index === -1) return fallback;
      const value = Number.parseInt(args[index + 1], 10);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`);
      return value;
    };
    const tagIndex = args.indexOf('--tag');
    const options = {
      everyNth: readPositiveInt('--every-nth', 1),
      maxFrames: readPositiveInt('--max-frames', Infinity),
      tag: tagIndex === -1 ? '' : String(args[tagIndex + 1] || ''),
    };
    for (const dir of targets) {
      console.log(`spatializing: ${dir}`);
      const r = await spatializeDir(dir, options);
      console.log(`  indexed ${r.indexed}/${r.processed} of ${r.total_frames} frames`);
      console.log(`  temporal ${r.continuity_status}: ${r.temporal_events} recurrence event(s)`);
      console.log(`  manifest ${r.temporal_manifest}`);
    }
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

  if (cmd === 'mcp') {
    await startMcpStdio();
    return;
  }

  if (cmd === 'search') {
    const nameOnly = args.includes('--name-only');
    const asJson = args.includes('--json');
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) || 25 : 25;
    const skip = new Set(limitIdx === -1 ? [] : [limitIdx, limitIdx + 1]);
    const q = args
      .filter((a, i) => !skip.has(i) && !a.startsWith('--'))
      .join(' ');
    if (!q) { usage(); process.exit(1); }

    const result = searchIndex(q, {
      nameOnly,
      limit,
      highlight: !asJson && Boolean(process.stdout.isTTY),
    });
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.hint && result.emptyIndex) console.log(result.hint);

    if (!nameOnly) {
      if (result.content.length) {
        console.log(`\ncontent matches (${result.content.length}):`);
        for (const h of result.content) {
          const rel = h.path.length > 90 ? '…' + h.path.slice(-89) : h.path;
          console.log(`  ${rel}`);
          console.log(`    ${h.snippet.slice(0, 160)}`);
        }
      } else {
        console.log('no content matches');
      }
    }

    if (result.filenames.length) {
      console.log(`\nfilename matches (${result.filenames.length}):`);
      for (const h of result.filenames) {
        const rel = h.path.length > 90 ? '…' + h.path.slice(-89) : h.path;
        console.log(`  ${rel}  (${h.sizeLabel})`);
      }
    }
    return;
  }

  if (cmd === 'stats') {
    const asJson = args.includes('--json');
    const stats = indexStats();
    if (asJson) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }
    console.log(`indexed files: ${stats.indexedFiles.toLocaleString()} (${stats.bytesLabel})`);
    console.log(`full-text bodies: ${stats.fullTextBodies.toLocaleString()}`);
    if (stats.hint && stats.emptyIndex) console.log(stats.hint);
    console.log('\nby volume:');
    for (const v of stats.byVolume) {
      console.log(`  ${String(v.volume).padEnd(30)} ${String(v.files.toLocaleString()).padStart(9)} files  ${v.sizeLabel}`);
    }
    console.log('\ntop extensions:');
    console.log('  ' + stats.topExtensions.map((e) => `${e.ext}:${e.count.toLocaleString()}`).join('  '));
    return;
  }

  usage();
  process.exit(cmd ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
