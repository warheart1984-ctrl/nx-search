import { createHash } from 'node:crypto';

export const TEMPORAL_SCHEME = 'HoloRT4D-Temporal-V1';
export const TEMPORAL_STATUS = 'partial_with_gaps';

/**
 * Build an honest temporal continuity record from spatial-token hashes.
 *
 * Exact hash recurrence proves only that the same categorical spatial field
 * returned. It is not proof of semantic object identity or of occlusion; a cut
 * or a return to the same view can produce the same evidence.
 */
export function analyzeTemporalSequence(samples, { failures = [], tag = '' } = {}) {
  const frames = [];
  const events = [];
  const lastSeenByHash = new Map();

  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const previous = index > 0 ? samples[index - 1] : null;
    const matchedIndex = lastSeenByHash.get(sample.hash);

    let relation = 'initial';
    let matchedFrame = null;
    if (previous) {
      if (previous.hash === sample.hash) {
        relation = 'stable_exact';
        matchedFrame = previous.frame;
      } else if (matchedIndex != null && matchedIndex < index - 1) {
        relation = 'reappeared_exact';
        matchedFrame = samples[matchedIndex].frame;
        events.push({
          type: 'spatial_field_recurrence_after_interruption',
          before_frame: matchedFrame,
          interruption_frames: samples.slice(matchedIndex + 1, index).map((item) => item.frame),
          after_frame: sample.frame,
          spatial_match_confidence: 1,
          semantic_identity: 'unknown',
          adjudication: 'unknown',
          hypotheses: ['occlusion', 'cut', 'return_to_view'],
        });
      } else {
        relation = 'changed_unknown';
      }
    }

    frames.push({
      index,
      frame: sample.frame,
      spatial_hash: sample.hash,
      previous_spatial_hash: previous?.hash ?? null,
      relation,
      matched_frame: matchedFrame,
      spatial_match_confidence: relation === 'stable_exact' || relation === 'reappeared_exact' ? 1 : null,
      semantic_identity: 'unknown',
      visibility_state: 'unknown',
    });
    lastSeenByHash.set(sample.hash, index);
  }

  const sequenceHash = createHash('sha256')
    .update(
      JSON.stringify({
        scheme: TEMPORAL_SCHEME,
        tag,
        frames: samples.map(({ frame, hash }) => [frame, hash]),
      }),
      'utf8',
    )
    .digest('hex');

  return {
    scheme: TEMPORAL_SCHEME,
    status: TEMPORAL_STATUS,
    sequence_hash: sequenceHash,
    tag: String(tag || ''),
    evidence_model: 'exact_spatial_hash_recurrence',
    truth_boundaries: {
      pseudo_depth_source: 'grayscale_luminance_inversion',
      pseudo_depth_status: 'partial',
      metric_calibration: 'declared',
      semantic_object_identity: 'unknown_without_object_or_identity_evidence',
      occlusion_vs_cut: 'unknown_without_visibility_or_shot_evidence',
      no_return_inference: 'not_supported_from_categorical_depth_bin',
      bin_255_meaning: 'maximum_relative_pseudo_depth_only',
    },
    frames,
    events,
    failures: failures.map(({ frame, error }) => ({ frame, error })),
  };
}

export function formatTemporalMemory(manifest, frame = null) {
  const lines = [
    `HOLORT4D TEMPORAL MEMORY scheme=${manifest.scheme} status=${manifest.status}`,
    `SEQUENCE hash=sha256:${manifest.sequence_hash}`,
    'EVIDENCE exact spatial-token hash recurrence only',
    'BOUNDARY semantic identity=unknown; occlusion-vs-cut=unknown',
    'BOUNDARY categorical bin 255 is not a no-return mask',
  ];

  if (frame) {
    lines.push(
      `FRAME ${frame.frame} index=${frame.index} relation=${frame.relation}`,
      `SPATIAL hash=sha256:${frame.spatial_hash}`,
      `SEMANTIC_IDENTITY ${frame.semantic_identity}`,
      `VISIBILITY ${frame.visibility_state}`,
    );
    if (frame.matched_frame) lines.push(`EXACT_MATCH prior_frame=${frame.matched_frame}`);
  }

  const relevantEvents = frame
    ? manifest.events.filter(
        (event) =>
          event.before_frame === frame.frame ||
          event.after_frame === frame.frame ||
          event.interruption_frames.includes(frame.frame),
      )
    : manifest.events;
  for (const event of relevantEvents) {
    lines.push(
      `EVENT ${event.type} before=${event.before_frame} interruption=${event.interruption_frames.join(',')} after=${event.after_frame}`,
      `EVENT_INTERPRETATION ${event.adjudication} hypotheses=${event.hypotheses.join('|')}`,
    );
  }
  if (manifest.failures.length) lines.push(`GAPS failed_frames=${manifest.failures.map((item) => item.frame).join(',')}`);
  return lines.join('\n');
}
