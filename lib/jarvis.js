import { retrieve, buildContext, citationMap } from './rag.js';
import { classifyIntent, modeConfig, memoryBlock, logReplay } from './amul.js';

export async function runJarvis(question, { onToken } = {}) {
  const t0 = Date.now();
  const { mode, useRetrieval } = classifyIntent(question);
  const cfg = modeConfig(mode);
  const { activeProvider, chat } = await import('./llm.js');

  let chunks = [];
  let pathMatched = [];
  let context = '';
  if (useRetrieval) {
    ({ chunks, pathMatched } = retrieve(question));
    context = buildContext(chunks);
  }

  const cites = citationMap(chunks);
  const sys = `You are JARVIS, a precise assistant with search access over the user's local drives.
Current mode: ${mode}. Answer style: ${mode === 'creative' ? 'imaginative and expressive' : mode === 'code' ? 'technically exact, code-first' : mode === 'file_research' ? 'evidence-based, cite files as [n]' : 'conversational and helpful'}.
When context from the user's files is provided and relevant, ground your answer in it and cite files as [n]. If it does not contain the answer, say so plainly.
Be concise. Use markdown sparingly.${memoryBlock()}`;

  let ctxBlock = '';
  if (context) {
    ctxBlock = `\n\nSEARCH CONTEXT FROM USER'S FILES:\n${context}\n\nPATH HITS: ${pathMatched.slice(0, 5).join(' | ') || 'none'}\nAVAILABLE CITATIONS:\n${cites.join('\n')}`;
  }

  // Main brain: Meta Muse-Glimmer via NVIDIA (131k context, controllable
  // reasoning strength). Reasoning effort scales with task complexity:
  //   creative -> low (fast muse flow)
  //   chat     -> medium
  //   code/file_research -> high (long tool chains without looping)
  // Override level with NX_REASONING_EFFORT, disable muse with NX_CREATIVE_MODEL=0.
  const museEnabled =
    Boolean(process.env.NVIDIA_API_KEY) &&
    process.env.NX_CREATIVE_MODEL !== '0';

  const EFFORT_BY_MODE = {
    creative: 'low',
    chat: 'medium',
    code: 'high',
    file_research: 'high',
  };
  const reasoningEffort =
    process.env.NX_REASONING_EFFORT || EFFORT_BY_MODE[mode] || 'medium';

  const useMuse = museEnabled;
  const museModel =
    process.env.NX_MAIN_MODEL || 'meta/muse-glimmer-30b';

  const answer = await chat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: `${question}${ctxBlock}` },
    ],
    {
      temperature: cfg.temperature,
      onToken,
      ...(useMuse
        ? {
            forceProvider: 'nvidia',
            model: museModel,
            reasoningEffort,
          }
        : {}),
    },
  );

  const meta = {
    mode,
    provider: useMuse ? 'nvidia' : activeProvider(),
    model: useMuse
      ? `${museModel} (reasoning: ${reasoningEffort})`
      : process.env.NX_LLM_MODEL || (activeProvider() === 'ollama' ? process.env.NX_OLLAMA_MODEL || 'qwen2.5:3b' : 'provider default'),
    durationMs: Date.now() - t0,
    evidenceCount: chunks.length,
  };
  logReplay({ ts: new Date().toISOString(), question, ...meta, citations: cites });

  return { answer, citations: cites, meta, searched: useRetrieval, emptyIndex: useRetrieval && !chunks.length && !pathMatched.length };
}
