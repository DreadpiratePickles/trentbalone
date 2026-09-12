# Trent — Local Models (Parked)

> Pulled out of the master task list at user's direction (2026-05-26).
> Trent's production runtime will use **OpenAI + Anthropic only**.
> This file holds anything related to running Trent against local models (Ollama, LM Studio, vLLM, etc.) so it can be picked up as a separate workstream — useful for offline dev, cost experiments, air-gapped customer demos, and future on-prem SKU exploration.

**Legend** · `- [ ]` open · `- [x]` done · `🧪` requires eval · `🔬` research / spike

---

## L1 — Local Runtime Setup

- [ ] **L1.1 — Hardware sanity check** 🔬
  - [ ] Confirm dev machine specs (RAM, VRAM, GPU model)
  - [ ] Decide minimum hardware target for local dev (e.g. M-series Mac w/ 32GB+, or workstation w/ 24GB+ VRAM)
  - [ ] Document hardware constraints per model size in `docs/dev/local-models-hardware.md`
- [ ] **L1.2 — Ollama install**
  - [ ] Install Ollama (`brew install ollama` or platform installer)
  - [ ] Verify daemon: `ollama serve` healthcheck on `:11434`
  - [ ] Pull baseline models:
    - [ ] `ollama pull llama3.1:8b` (cheap eval pass)
    - [ ] `ollama pull llama3.1:70b` (reasoning-class, if hardware supports)
    - [ ] `ollama pull qwen2.5-coder:7b` and `qwen2.5-coder:32b` (engineering agent)
    - [ ] `ollama pull mistral-small:24b` (general router fallback)
    - [ ] `ollama pull nomic-embed-text` (embeddings)
    - [ ] `ollama pull bge-reranker-v2` (reranker, if available)
  - [ ] Confirm `ollama list` shows everything
- [ ] **L1.3 — LM Studio install**
  - [ ] Install LM Studio
  - [ ] Load same checkpoints as Ollama for parity tests
  - [ ] Enable OpenAI-compatible server on `:1234`
  - [ ] Save a "Trent Dev" preset (context length, temperature defaults)
- [ ] **L1.4 — vLLM option (later)** 🔬
  - [ ] Evaluate vLLM for higher-throughput batch eval runs
  - [ ] Spike: spin up vLLM in Docker against a 7B model
  - [ ] Compare tokens/sec vs Ollama and LM Studio
- [ ] **L1.5 — Local environment variables**
  - [ ] Add `LOCAL_LLM_BASE_URL` to `.env.example`
  - [ ] Add `LOCAL_LLM_MODEL` (defaults to a small model for CI)
  - [ ] Add `LOCAL_LLM_PROVIDER` (`ollama | lmstudio | vllm`)
  - [ ] Document the variables in `docs/dev/local-models.md`

---

## L2 — Local Adapter in the Model Gateway

- [ ] **L2.1 — Provider adapter**
  - [ ] Add `local` provider adapter alongside `openai`, `anthropic`
  - [ ] Wire through OpenAI-compatible client (both Ollama and LM Studio expose this surface)
  - [ ] Implement streaming pass-through
  - [ ] Map tool-use calls (note: many local models have partial / unreliable tool-use; flag in adapter)
- [ ] **L2.2 — Routing policy**
  - [ ] Add `dev` routing tier: dev/local → cloud-fallback
  - [ ] Add per-agent override so dev can pin a local model for a single agent
  - [ ] Add "force-local" env flag for offline development
- [ ] **L2.3 — Schema-enforcement compatibility**
  - [ ] Test which local models reliably return structured JSON
  - [ ] Add retry-with-feedback loop tuned for local models (they need more retries)
  - [ ] Document per-model JSON reliability score
- [ ] **L2.4 — Cost / latency telemetry**
  - [ ] Surface local-model latency in the same telemetry path as cloud
  - [ ] Cost = $0 (label clearly in the FN agent's cost report so it doesn't pollute customer-facing numbers)

---

## L3 — Local Eval Workflow 🧪

- [ ] **L3.1 — Eval subset definitions**
  - [ ] Carve a `local-friendly` subset of every agent's eval set (cases that don't require external tool calls)
  - [ ] Tag each case with required-model-capability (long-context / tool-use / multimodal / code)
- [ ] **L3.2 — Local eval runner**
  - [ ] `pnpm eval:local --agents pm,fn,ot,classify`
  - [ ] Output: same eval report shape as cloud runs
  - [ ] Compare score deltas vs cloud baseline
- [ ] **L3.3 — CI integration**
  - [ ] Optional self-hosted runner with local Ollama
  - [ ] Run `eval:local` on every PR touching prompts (cheap regression catch)
  - [ ] Block merge only on hard regressions (e.g. >15% drop on classification tasks where local is expected to be competitive)
- [ ] **L3.4 — Model comparison reports**
  - [ ] Spreadsheet / dashboard: cloud vs local per agent
  - [ ] Track over time as local models improve

---

## L4 — Which Agents Can Run on Local Today

> Honest read: most cannot. Local models are useful for the cheap classification + routing layer, occasional code review, and offline dev. Don't ship a customer-facing agent on local.

- [ ] **L4.1 — Classification & routing**
  - [ ] Run intent detection on `qwen2.5:7b` or `llama3.1:8b`
  - [ ] Benchmark vs Haiku / Gemini Flash
- [ ] **L4.2 — OT (Ops) agent**
  - [ ] Vendor status watching, webhook health — viable on local 8B
- [ ] **L4.3 — FN (Finance) read-only summarization**
  - [ ] Numeric report generation — viable on a 24B+ local model
- [ ] **L4.4 — EG (Engineer) code review (not generation)** 🔬
  - [ ] Spike: `qwen2.5-coder:32b` reading PR diffs and flagging issues
  - [ ] Compare against Sonnet-class on the same diffs
- [ ] **L4.5 — All other agents**
  - [ ] Punt to cloud (OpenAI / Anthropic) until local reasoning quality catches up

---

## L5 — Offline Development Mode

- [ ] **L5.1 — `OFFLINE=true` env switch**
  - [ ] All model calls route to local
  - [ ] All external integrations stubbed with deterministic fixtures
  - [ ] All emails / posts / merges become dry-run-only
- [ ] **L5.2 — Fixture library**
  - [ ] Seed GitHub repo fixture, Stripe charge fixture, Slack thread fixture
  - [ ] Wire each MCP server to fixture mode when `OFFLINE=true`
- [ ] **L5.3 — Offline docs**
  - [ ] `docs/dev/offline-development.md` — runbook for working on a plane
  - [ ] Known-broken list (which features can't be exercised offline)

---

## L6 — Future Exploration (Not Roadmapped)

- [ ] **L6.1 — On-prem / VPC SKU** 🔬
  - [ ] Demand signal threshold: ≥3 paying customers requesting it unprompted
  - [ ] Architecture sketch: which components must run inside the VPC
  - [ ] Pricing implications (likely 3-5× headline ACV)
- [ ] **L6.2 — Bedrock / Azure-OpenAI fallback** 🔬
  - [ ] Sometimes "local" really means "the customer's cloud account"
  - [ ] Bedrock Claude + Azure OpenAI cover most enterprise data-residency asks
- [ ] **L6.3 — Open-weights frontier models** 🔬
  - [ ] Re-evaluate quarterly: any open model competitive with Sonnet?
  - [ ] If yes, revisit routing to lower marginal cost on high-volume agents

---

_Parked file — work on this independently from the master roadmap._
_Re-merge selected items into `trent-master-tasklist.md` only when local genuinely beats cloud on a measurable agent metric or when an enterprise deal requires it._
