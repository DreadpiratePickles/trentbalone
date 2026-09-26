# Local models on Trent: the plan (2026-09-26)

Sources: 01_discovery/output/trent-local-path-audit-2026-09-26.md (the audit of HEAD 412f5b0 with a
live run on this machine), local-models-2026-09-26.md (runtimes, models, requirements, with URLs),
harness-openai / harness-anthropic / harness-others-2026-09-26.md (what the field does).

## Where we stand, precisely
Trent cannot run on local models today. `provider: ollama` is accepted; the planner and the critic
reach the local server; every seat call is sent as `gpt-5.2` or `gpt-4.1-mini` because the app's
model table is fixed at CLI start before the config's models apply (audit G1). On this machine the
planner itself timed out at the app client's 60 s on a 27B model (G2). A pinned model whose name
contains "mistral" was routed to api.mistral.ai (G4, a leak with no real key). Sixteen further
gaps degrade the run (setup refuses the provider, doctor exits 0 with the server down, the embedder
404s and silently goes lexical, the judge falls back to a Gemini model, a false DEGRADED banner,
`:cloud` Ollama models priced as local). With a shell workaround, against a fake local server, every
call used the local model, tool calls parsed and ran, and cost recorded 0 cents: the architecture
is close; the defaults, the timeouts, the routing and the truth-telling are not.

## What "good" looks like (from the field)
Perplexity's on-device mode: a compact core prompt, connectors rewritten as small CLI tools,
skills loaded on demand, and a frontier "advisor" the local model may consult only with approval
after a privacy preview. Goose and OpenClaw: pick a model that fits the machine, state the limits
plainly (context, which models call tools reliably). OpenHands: one recommended model with a
minimum context. Codex: Responses-API-only local path where MCP tools never reach the model, a
warning of what not to do. Anthropic: no local path at all.

## Waves

### L0: it runs, and tells the truth (breaks and the leak)
| Gap | Change | Failing test |
|---|---|---|
| G1, G5, G14 | Apply the config's model names before any import in `apps/cli/src/env-defaults.ts` (the model table in `apps/web/lib/ai-client.ts` reads env at load) so seats, the consolidator and the ledger carry the local model | a run under `provider: ollama` against a fake server sends only the configured model name on every call |
| G2, G16 | Per-provider timeouts sized for prefill: local providers get a time-to-first-token budget (default 300 s, `models.local.ttft_seconds`), streaming keeps the call alive, and the SDK timeout is classed retryable once | a fake server that answers after 90 s completes; the ledger shows one attempt |
| G4 | Routing by provider only, never by model-name substring; under a local provider no request may leave localhost (an egress test proves `mistral:7b` under ollama hits only the fake) | red today on `seat-gateway-port.ts:62-69` and `call-policy.ts:107` |
| G3, G15 | `trent setup --mode quick --provider ollama|lmstudio` needs no key; full setup stops saying a key is set | setup exits 0 and writes provider + model |
| G6 | Under a local provider the judge is a second local model or refuses with a message; never a hosted fallback | judge resolution test |
| G7 | DEGRADED means no usable provider, not no key | REPL banner test with provider ollama |
| G8, G13 | Doctor "Local Model" check: runtime reachable and version, model present, effective context window (Ollama /api/show, llama.cpp /props), slots, a five-case tool-call smoke test, time-to-first-token at the real prompt size; connectivity skips cloud hosts when the provider is local | check tests against a fake runtime; docs/doctor.md count 22 -> 23 |
| G9, G10 | Local embeddings through the runtime's embed endpoint (Qwen3-Embedding-0.6B / EmbeddingGemma / nomic-embed-text) with a calibrated floor; `none` stays honest; the app's wiki-embeddings 404 per step stopped by the env the app reads (read-only app: find the switch) | embedder test with a fake /api/embed; recall golden on the docs corpus with the local embedder recorded |
| G11 | An Ollama `:cloud` model is hosted: priced, labelled, and gated like a hosted model | pricing/labelling test |
| G12 | Docker down is a warning when `terminal.backend: local` | doctor test |
| G17 | Prompt-size gate: refuse a prompt over the effective window instead of silent truncation | test with a 4K window |

### L1: reliable on small models (the requirements from the field)
- Constrained output on local providers: `response_format: json_schema` for planner, critic and
  seat turns; the action string flattened to `{tool, args}` with `tool` an enum of allowed names.
- Repair, then retry, never fake success: control characters, fences and think blocks repaired;
  an unrepairable call recorded failed and re-asked once; unknown tool names rejected with
  suggestions; "a tool was required and none was called" re-asked with constrained output.
- Context budget per model: the tiers trimmed to fit (tool disclosure shrinks first, then the
  context tier), a per-seat `prompt-size` test in CI at 32K and 64K.
- Concurrency and cache: in-flight calls capped at the server's slots, keep-alive on, byte-identical
  prefixes per seat (P2-7 did the order), a prompt-cache hit check in the doctor.
- Hybrid escalation: `models.escalate` names a hosted model that only the planner and critic, or a
  failed step, may use, each time behind the approval gate with a privacy preview of exactly what
  would leave the machine (Perplexity's pattern, on Trent's existing gate).
- Judge on local: measure thinking models against the judge's 256-token limit (G18).

### L2: the product path
- `trent setup --mode local`: detect Ollama / LM Studio / llama.cpp, list pulled models, recommend by
  tier (16 GB: Qwen3.5-9B Q4; 24 GB GPU or 32 GB Mac: Qwen3.6-27B or Qwen3.8-27B Q4; 48-64 GB:
  Qwen3.6-35B-A3B; 128 GB+: gpt-oss-120b or Qwen3.5-122B-A10B for planner/critic, 35B-A3B seats),
  pull with consent, write config, run the doctor's smoke test, print the honest expectation
  (single tool calls mostly work at 9B; multi-step plans unreliable; prefill cost).
- docs/local-models.md; README row; the nightly sweep runs the local smoke on this machine.
- Default local model changed from `llama3.2` (21.95% overall, 4% multi-turn on Berkeley's
  leaderboard) to the tier recommendation.

## Decisions for Bobby (none block L0)
1. Pull one small tool-capable model (Qwen3.5-9B Q4, ~5.7 GB) on this machine for live proofs.
2. Hybrid escalation to Gemini: on by default (behind approval) or off until configured.
3. Whether the 27B already on this machine is the reference model for the nightly local smoke.

## Cost and size
L0: one wave of six Opus agents (each gap group its own task), no cloud spend, one day. L1: one
wave, local runs only. L2: half a wave. Every item red-first, landed through scripts/dev/isolate.sh.
