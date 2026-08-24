/**
 * Spatialize — give rendered frames a HoloRT4D spatial memory.
 *
 * Walks a directory of PNG frames, converts each to HoloRT4D-Spatial-V1
 * tokens, and writes them into the search index so any frame's depth
 * structure is recallable forever.
 */

import { readdir, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { openDb, upsertFile, replaceBody, insertBody } from './db.js';
import { analyzeTemporalSequence, formatTemporalMemory } from './temporal.js';
import { holoTokensForImage } from './vision.js';

const FRAME_EXTS = new Set(['.png', '.jpg', '.jpeg']);

export async function spatializeDir(dir, { everyNth = 1, maxFrames = Infinity, tag = '' } = {}) {
  const entries = (await readdir(dir))
    .filter((f) => FRAME_EXTS.has(extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const limit = Number.isFinite(maxFrames) ? Math.max(0, Math.floor(maxFrames)) : entries.length;
  const targets = entries.filter((_, i) => i % Math.max(1, everyNth) === 0).slice(0, limit);

  const results = [];
  const samples = [];
  for (const name of targets) {
    const fullPath = join(dir, name);
    try {
      const tokenized = await holoTokensForImage(fullPath);
      samples.push({ frame: name, path: fullPath, text: tokenized.text, hash: tokenized.hash });
      results.push({ frame: name, hash: tokenized.hash.slice(0, 12) });
    } catch (err) {
      results.push({ frame: name, error: String(err.message || err).slice(0, 160) });
    }
  }

  const failures = results.filter((result) => result.error);
  const temporal = analyzeTemporalSequence(samples, { failures, tag });
  const manifestPath = join(dir, '.holort4d-temporal.json');
  const tempManifestPath = `${manifestPath}.tmp-${process.pid}`;
  await writeFile(tempManifestPath, `${JSON.stringify(temporal, null, 2)}\n`, 'utf8');
  await rename(tempManifestPath, manifestPath);

  const db = openDb();
  let indexed = 0;
  try {
    const temporalByFrame = new Map(temporal.frames.map((frame) => [frame.frame, frame]));
    for (const sample of samples) {
      const body =
        `HOLORT4D SPATIAL MEMORY — frame ${sample.frame}${tag ? ` [${tag}]` : ''}\n` +
        `SOURCE grayscale_luminance_inversion status=partial metric_calibration=declared no_return_mask=absent\n` +
        `NOTE categorical bin 255 is relative pseudo-depth, not a no-return signal.\n` +
        `${sample.text}\n\n${formatTemporalMemory(temporal, temporalByFrame.get(sample.frame))}`;
      const fileStat = await stat(sample.path);
      const row = {
        path: sample.path,
        volume: sample.path.split('/')[1] || '/',
        name: sample.frame,
        ext: extname(sample.frame).toLowerCase(),
        size: fileStat.size,
        mtime: Math.floor(fileStat.mtimeMs),
        indexedAt: Date.now(),
        textStatus: 'spatial',
      };
      const insertStmt = upsertFile(db);
      const { id } = insertStmt.get(row);
      replaceBody(db).run(id);
      insertBody(db).run(id, sample.path, body.slice(0, 90_000));
      indexed++;
    }

    const manifestStat = await stat(manifestPath);
    const manifestRow = upsertFile(db).get({
      path: manifestPath,
      volume: manifestPath.split('/')[1] || '/',
      name: '.holort4d-temporal.json',
      ext: '.json',
      size: manifestStat.size,
      mtime: Math.floor(manifestStat.mtimeMs),
      indexedAt: Date.now(),
      textStatus: 'temporal',
    });
    replaceBody(db).run(manifestRow.id);
    insertBody(db).run(manifestRow.id, manifestPath, formatTemporalMemory(temporal).slice(0, 90_000));
  } finally {
    db.close();
  }

  return {
    indexed,
    total_frames: entries.length,
    processed: targets.length,
    results,
    temporal_manifest: manifestPath,
    temporal_events: temporal.events.length,
    continuity_status: temporal.status,
  };
}
