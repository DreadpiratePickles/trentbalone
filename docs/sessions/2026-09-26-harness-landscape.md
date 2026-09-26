# Harness landscape and local models, 2026-09-26

Bobby: "do some real in depth research about the best harnesses out here, gpt claude and
perplexity computer etc, and see what we're lacking and how we can incorporate this so people can
use local models on it and just see precisely where we lack." Deliverable: an evidence-backed
landscape and gap analysis with a local-model plan; no implementation in this session unless
Bobby says so.

## Method
Five Opus research agents (no subagents), primary sources only with URLs; one Trent-side audit
against HEAD with file evidence; Fable synthesis into 01_discovery/output/harness-landscape-
2026-09-26.md and 02_plan/output/local-models-plan-2026-09-26.md.

## Launched 01:05Z (five Opus agents, no subagents, read-only, one file each)
- R1 harness-openai: Codex CLI/app, Agents SDK, Responses built-in tools, ChatGPT agent, local
  models via --oss/Ollama/LM Studio.
- R2 harness-anthropic: Claude Code, Agent SDK, Managed Agents, Cowork; local/third-party model path.
- R3 harness-others: Perplexity Computer (a full page), Gemini CLI, OpenHands, Goose, Cline/Roo/
  Kilo, Cursor, Devin, Manus, Amp, Warp, Aider, 2026 launches with traction.
- R4 local-models: runtimes (Ollama, LM Studio, llama.cpp, vLLM, MLX), models by size class with
  tool-call reliability, local embeddings, how harnesses handle local models, failure modes,
  minimum viable stack per hardware tier, a testable requirements checklist for a harness.
- R5 trent-local-path-audit: the model path at HEAD with `models.provider: ollama`, a live run with
  no cloud key if Ollama is installed, embeddings/retrieval without a key, the gap list with
  file:line and a failing test per gap.
Fact at start: the gateway already accepts ollama/lmstudio/deepseek/groq aliases
(model-gateway/providers.ts) and setup treats ollama/lmstudio as keyless (setup/detect.ts).
- R2 landed (01_discovery/output/harness-anthropic-2026-09-26.md, 393 lines). Distinctive: auto-mode
  classifier (a second model reviews each action), OS-enforced bash sandbox with credential masking
  (open-sourced), dynamic workflows (a JS orchestration script the runtime executes, 16-256
  concurrent, resumable), four multi-agent shapes, 33 hook events, compaction that re-injects
  instructions/memory/plan/skills, sessions that move between devices, four scheduling levels,
  Managed Agents with outcome graders and memory stores, measured plugins (`claude plugin eval`).
  Local models: no first-party path anywhere; only ANTHROPIC_BASE_URL at the wire level, explicitly
  unsupported for non-Claude models. Conclusion: Trent's local support stays in its own gateway.
- R3 landed (01_discovery/output/harness-others-2026-09-26.md). Perplexity Computer (2026-02-25):
  cloud digital worker, subagents in isolated environments, tasks for hours to months, 20+ models
  with a switchable lead, Effort levels, a Model Council, 400+ connectors + MCP, credential vault,
  per-tool "Always ask", Brain memory (source-linked, refreshed overnight, wiki pages), work from
  web/mobile/Slack/M365/email/a 24/7 Mac mini; ON-DEVICE mode on 24 GB+ hardware running Qwen 3.8
  27B (or Perplexity's post-trained one) with connectors rewritten as compact CLI tools, skills on
  demand, and a frontier "advisor" the local model may ask only with approval after a privacy
  check. Field: Goose (llama.cpp in-app, model picked for your memory; tool calls reliable only on
  Gemma 4, 4-8K context), OpenClaw (managed llama.cpp, 64K, hosted->local fallback, lives in 20+
  chat channels), OpenHands (Qwen3.6-35B-A3B via LM Studio/Ollama/vLLM, 22K+ context; Agent Canvas
  over ACP), Cline Desktop (import a Claude Code/Codex session onto an open-weight model), Gemini
  CLI Rewind, Goose Adversary Mode, Cursor Projects coordinator, Devin video proofs, Manus Branch,
  Amp Orbs, DeepSeek Harness (236k stars since Aug 13, any endpoint, no local guidance). Roo Code
  shut down 2026-05-15; Gemini CLI, Warp and Cursor cannot use a local main model.
- R1 landed (01_discovery/output/harness-openai-2026-09-26.md, 198 rows). New: the Agents API
  (2026-09-10, beta) runs the open-source Codex harness as a managed service (durable sessions,
  hosted sandboxes, nine third-party sandbox providers; no local/third-party model, no ZDR).
  Distinctive: one harness three ways (local, managed, `codex exec-server` in your sandbox);
  sandboxed by default on every desktop OS (seatbelt/bubblewrap+seccomp/native), workspace-write,
  network off; auto-review by a reviewer agent at the sandbox edge; secrets as placeholders swapped
  by a proxy for approved hosts; server-side encrypted compaction; deferred and grouped tools with
  keyword tool search; Programmatic Tool Calling (JS over many tools in an isolated runtime);
  multi-agent create/message/wait/interrupt as typed events (6 concurrent); Record & Replay skills
  from a demonstration; import from Claude Code/Cowork/Cursor. Local: `codex --oss` with
  oss_provider ollama|lmstudio, default gpt-oss:20b (16 GB) / gpt-oss-120b (80 GB), 64k context
  recommended; Responses API only (Chat Completions removed Feb 2026); MCP tools sent in a wrapper
  local servers do not understand, so they never reach the model; no native edit tool for
  third-party models; subagents ignore model_provider; Agents SDK local via Chat Completions with
  tool search/deferred/PTC rejected. Retired: Evals platform and Agent Builder on 2026-11-30,
  Assistants API 2026-08-26, codex mcp-server. Codex does not strip *KEY*/*SECRET*/*TOKEN* from
  spawned commands by default.
- R5 landed (01_discovery/output/trent-local-path-audit-2026-09-26.md). VERDICT: Trent cannot run
  on local models today. `provider: ollama` sets; planner and critic reach Ollama; every SEAT call
  is sent as gpt-5.2 / gpt-4.1-mini (404) because gepa/index.ts:16 -> apps/web/lib/gepa.ts:31 ->
  ai-client.ts fixes the model table at CLI startup before the config's models apply (G1); on this
  machine the planner itself timed out at 60 s (ai-client.ts:117) on the 11 GB Qwen 27B (35 tok/s
  prompt, 1.3 tok/s generation, swapping) (G2). Workaround: export OPENAI_MODEL_FAST/DEFAULT/
  STRONG/CRITIC=<model>; against a fake OpenAI-compatible server every call then used the local
  model, tool calls parsed and ran, 0 cents under ollama. LEAK (G4): a pinned model named
  mistral:7b was sent to api.mistral.ai with the placeholder bearer "local" (401); names containing
  mistral/gemini/claude are refused as seats (seat-gateway-port.ts:62-69, call-policy.ts:107).
  Other gaps: quick setup refuses --provider ollama and asks for OLLAMA_API_KEY (G3); the
  consolidator's callText bypasses the gateway (G5); the improve judge falls back to
  gemini-3.5-pro (G6); false DEGRADED banner (G7); doctor never checks the local server/model and
  exits 0 with Ollama unreachable (G8); the embedder asks Ollama for text-embedding-3-small, 404,
  silently lexical (G9); wiki-embeddings.ts makes the same 404 every step (G10); an Ollama :cloud
  model priced 0 and called local (G11); doctor fails on Docker down (G12); connectivity resolves
  only api.openai.com (G13); ledger records gpt-* names (G14); full setup says OLLAMA_API_KEY set
  (G15); the SDK timeout classed internal, never retried (G16); nothing checks Ollama's context
  size, prompts silently truncated (G17); thinking models vs the judge's 256-token limit (G18).
  Brain import works without a key; recall is lexical-only in effect. No small model pulled
  (needs Bobby's OK for a download); the audit permitted no cloud call and one unintended request
  left the machine (the G4 leak, with no real key).
- R4 landed (01_discovery/output/local-models-2026-09-26.md, 554 lines). Minimum stacks: 16 GB Mac
  Qwen3.5-9B Q4 + Qwen3-Embedding-0.6B + whisper base; 24 GB GPU / 32 GB Mac Qwen3.6-27B or
  Qwen3.8-27B Q4 (~17 GB), 48-64 GB Qwen3.6-35B-A3B, gpt-oss-20b as the speed choice; 128 GB+
  gpt-oss-120b or Qwen3.5-122B-A10B for planner/critic with 35B-A3B seats. Requirements:
  constrained output (json_schema) on local providers with the action string flattened to
  {tool, args}; effective context window read from the server and prompts refused over budget;
  byte-identical prefixes, slot-limited concurrency, prefill-sized timeouts; repair-then-retry,
  never fake success; a local-stack doctor with a tool-call smoke test and TTFT. Failure modes:
  silent context truncation (Ollama 4K default under 24 GiB), broken tool calls (tabs in JSON,
  truncated args replaced by {}, abstain rates 45-54% on Llama 4/3.3), cold prefill and cache
  thrash across eleven roles. Trent-specific: default llama3.2 scores 21.95% / 4% multi-turn.
- Plan written: 02_plan/output/local-models-plan-2026-09-26.md (L0 runs and tells the truth;
  L1 reliable on small models; L2 the product path; three decisions for Bobby, none blocking).
- Bobby (01:40Z): "take all the things you've learnt and apply it to making a better product; also
  recreate a base harness for people that just want to use it like Hermes without the 9 agents."
  Wave L0 launched (five Opus agents, no subagents): L0-1 routing truth + the mistral leak +
  :cloud labelling; L0-2 every OpenAI-compatible provider through the wrapper client, prefill-sized
  timeouts, prompt budget, slot-limited concurrency; L0-3 setup for local providers, honest
  DEGRADED, local judge, tier default model (pulls one small Qwen); L0-4 doctor Local Model check
  (23rd), connectivity, Docker warn; L0-5 local embeddings with calibrated floors, the app's
  wiki-embeddings 404 stopped, local recall recorded. R6 matrix still running. Next: the base
  harness ("solo mode") design, then wave S.
- Solo mode design written: 02_plan/output/solo-harness-design-2026-09-26.md. Decision: a second
  runner behind the existing AgentRunner port yielding the same OrcEvents, so every surface, the
  ledger, approvals and checkpoints work unchanged; `agent.mode: fleet|solo`, `trent --solo`.
  Waves S1-S4 after L0 frees slots; an Opus adversarial review runs beside S1.
- R6 landed (01_discovery/output/harness-matrix-2026-09-26.md, 56 rows: parity 14, ahead 6,
  partial 24, missing 9, deliberately-not 3). Synthesis written: 01_discovery/output/harness-
  landscape-2026-09-26.md with the ten gaps mapped to waves L0-L2, S1-S4, H1-H5 and Bobby's steps.
- S1 (solo core loop) launched.
