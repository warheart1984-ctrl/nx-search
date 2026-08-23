import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOLO_CORE =
  '/media/jon/New Volume/Mandala Rendering Software/mrs/packages/renderer-core/src/render/rt4d/holort4d/spatial-tokens/index.js';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export async function imageToPseudoDepth(path, { resolution = 16, targetPixels = 65536 } = {}) {
  const sharp = (await import('sharp')).default;
  const img = sharp(path).grayscale();
  const meta = await img.metadata();
  const scale = Math.min(1, Math.sqrt(targetPixels / (meta.width * meta.height)));
  const w = Math.max(resolution, Math.round(meta.width * scale));
  const h = Math.max(resolution, Math.round(meta.height * scale));
  const { data, info } = await img.resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });

  const n = info.width * info.height;
  const depthF32 = new Float32Array(n);
  for (let i = 0; i < n; i++) depthF32[i] = 1 - data[i] / 255;

  return { depthF32, width: info.width, height: info.height };
}

export async function holoTokensForImage(path, { resolution = 16 } = {}) {
  const { depthF32, width, height } = await imageToPseudoDepth(path, { resolution });
  const core = await import(pathToFileURL(resolve(HOLO_CORE)).href);
  const token = core.tokenizeFromDepthGrid(depthF32, { width, height, resolution });
  return {
    text: core.formatForLLM(token),
    hash: core.hashSpatialToken(token),
    scheme: 'HoloRT4D-Spatial-V1',
    status: core.SPATIAL_TOKEN_STATUS,
  };
}

export async function visionDescribe(path, question) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY not set — native vision needs the cloud provider');
  const ext = extname(path).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`unsupported image type ${ext} (${Object.keys(MIME).join(', ')})`);
  const b64 = (await readFile(path)).toString('base64');

  const model = process.env.NX_VISION_MODEL || 'meta/llama-3.2-90b-vision-instruct';
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                question ||
                'Describe this image precisely: subject, layout, any visible text, colors, and its likely purpose. Be concise but complete.',
            },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content?.trim() || '';
}

export async function describeFull(path, { question, holo = true, native = true, resolution = 16 } = {}) {
  const parts = [];
  if (native) parts.push(await visionDescribe(path, question));
  if (holo) {
    try {
      const t = await holoTokensForImage(path, { resolution });
      parts.push(`\n--- HoloRT4D-Spatial-V1 tokens (${t.scheme}, sha256:${t.hash.slice(0, 12)}) ---\n${t.text}`);
    } catch (err) {
      parts.push(`\n(holort4d tokenize failed: ${err.message})`);
    }
  }
  return parts.filter(Boolean).join('\n\n');
}
