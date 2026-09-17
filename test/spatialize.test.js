import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

const HOLO_CORE =
  '/media/jon/New Volume/Mandala Rendering Software/mrs/packages/renderer-core/src/render/rt4d/holort4d/spatial-tokens/index.js';

test('records exact reappearance without inventing identity or occlusion', async (t) => {
  try {
    await access(HOLO_CORE);
  } catch {
    t.skip('HoloRT4D spatial token core is not mounted on this machine');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'nx-temporal-'));
  const framesDir = join(root, 'frames');
  await mkdir(framesDir);
  process.env.NX_SEARCH_DB = join(root, 'index.db');

  try {
    const visible = {
      create: { width: 32, height: 32, channels: 3, background: '#f4f4f4' },
    };
    const interrupted = {
      create: { width: 32, height: 32, channels: 3, background: '#202020' },
    };
    await sharp(visible).composite([{ input: Buffer.from(
      '<svg width="32" height="32"><rect x="10" y="6" width="12" height="20" fill="#303030"/></svg>',
    ) }]).png().toFile(join(framesDir, 'frame_001.png'));
    await sharp(interrupted).png().toFile(join(framesDir, 'frame_002.png'));
    await sharp(visible).composite([{ input: Buffer.from(
      '<svg width="32" height="32"><rect x="10" y="6" width="12" height="20" fill="#303030"/></svg>',
    ) }]).png().toFile(join(framesDir, 'frame_003.png'));

    const { spatializeDir } = await import('../lib/spatialize.js');
    const result = await spatializeDir(framesDir, { tag: 'lesson-one' });
    assert.equal(result.indexed, 3);
    assert.equal(result.processed, 3);
    assert.equal(result.temporal_events, 1);
    assert.equal(result.continuity_status, 'partial_with_gaps');

    const manifest = JSON.parse(await readFile(result.temporal_manifest, 'utf8'));
    assert.equal(manifest.scheme, 'HoloRT4D-Temporal-V1');
    assert.equal(manifest.frames[2].relation, 'reappeared_exact');
    assert.equal(manifest.frames[2].matched_frame, 'frame_001.png');
    assert.equal(manifest.frames[2].semantic_identity, 'unknown');
    assert.equal(manifest.frames[2].visibility_state, 'unknown');
    assert.equal(manifest.events[0].adjudication, 'unknown');
    assert.deepEqual(manifest.events[0].hypotheses, ['occlusion', 'cut', 'return_to_view']);
    assert.equal(manifest.truth_boundaries.no_return_inference, 'not_supported_from_categorical_depth_bin');
    assert.equal(manifest.truth_boundaries.bin_255_meaning, 'maximum_relative_pseudo_depth_only');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
