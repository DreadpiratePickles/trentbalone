# Trent on local models only — path audit (2026-09-26)

Stage: 01_discovery. Read-only on the repo; this file is the only write. Repo `/Users/bobbymeher/Desktop/trent`,
branch `feature/trent-fleet-v2`, HEAD `412f5b0`. Every claim below cites a file:line at HEAD or a command
whose exit code is listed in section 7. No cloud key was read or used; `gem.env` was not opened.

## 0. Verdict

**Breaks.** A user can configure `provider: ollama` (only via `trent config set`; quick setup refuses it). The
planner and the critic reach the local model, but every **seat** call asks Ollama for `gpt-5.2` or `gpt-4.1-mini`,
because the app's `MODELS` table is frozen before the provider bridge runs (`gepa/index.ts:16`). On real Ollama
those ids 404, so no step runs on a local model today. On this machine the run died even earlier: the app's
60 s header timeout killed the planner call during prompt evaluation of a 27B model (`planner call failed:
internal (Request timed out.)`, 187 s, exit 1). With four `OPENAI_MODEL_*` variables exported in the shell as a
workaround, every call reaches the local model (verified against a fake OpenAI-compatible server), so the
remaining gaps are degradations (embeddings, doctor, banner, judge), not breaks.

## 1. Environment and method

- Ollama 0.32.9 at `/usr/local/bin/ollama`, serving on 127.0.0.1:11434. LM Studio not running (port 1234 refused).
- Local models: `qwen3.8-27b-abliterated:latest` (16 GB, Q4_K_M) and
  `hf.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:latest` (11 GB, Q2_K); both list `tools`, `thinking`,
  `completion`. `nemotron-3-ultra:cloud` is an Ollama **cloud** model (size `-`) and was not used.
- Machine: Apple M1 Max, 32 GiB, swap 13.3 of 14.3 GB in use during the audit. Ollama ran the 11 GB model through
  its bundled `llama-server` at `-c 32768`, 13 GB resident.
- **No model was pulled.** No model under 5 GB was present. The brief allowed pulling `qwen3:4b`
  (registry.ollama.ai, about 2.5 GB), but a download needs Bobby's explicit OK. So the live half ran on the
  smallest model already present (11 GB Q2_K), and the small-model live run is pending that OK.
- Isolation: every `trent` command ran as `env -i` with a scratch `HOME` and `TRENT_HOME`, plus
  `TRENT_QUEUE_FALLBACK=disabled`, through `node_modules/.bin/tsx apps/cli/src/index.ts`. `trent` is not on PATH, and
  `apps/cli/dist` dates from Sep 12. The shell's `ANTHROPIC_BASE_URL` was therefore not inherited. Scratch files
  are in the session scratchpad, not the repo.
- The code paths the live model never reached were driven against a fake OpenAI-compatible server configured as
  `ollama` (`OLLAMA_BASE_URL=http://127.0.0.1:<port>/v1`). The fake logs each request's model id and prompt size.
- **Disclosure — one unintended outbound request.** The probe of a pinned model named `mistral:7b` through
  `gateway.complete` went to `https://api.mistral.ai/v1/chat/completions` with the prompt `"hi"` and the bearer
  `local`, and came back as a 401. `local` is the non-secret placeholder that `providers.ts:186` writes. The request
  was not intended; it is gap G4, found by accident. It was not repeated. The destination was confirmed from the code
  afterwards: `apps/web/lib/ai-client.ts` `openAiCompatibleClient` has base URL `https://api.mistral.ai/v1` and an
  undefined apiKey, and openai-node 4.104.0 then falls back to `OPENAI_API_KEY`.

## 2. Component map with `provider: ollama`

| Component | What it does with `provider: ollama` | Evidence | Status |
|---|---|---|---|
| `config/sections/models.ts` | `ollama`/`lmstudio` accepted by `ProviderSchema` | `models.ts:14-24` | Works |
| `setup/detect.ts` + `QuickSetup.ts` | Keyless providers have no env var, so `detectProviderKeys` finds nothing and quick setup aborts with "Set OLLAMA_API_KEY", a variable nothing reads | `detect.ts:20-21,126`; `QuickSetup.ts:32-43`; live exit 3, and still exit 3 with `OLLAMA_API_KEY=local` | **Breaks** |
| `setup/FullSetup.ts` | Accepts ollama, but needs a TTY (exit 2 from a pipe); would print "OLLAMA_API_KEY is already set" | `FullSetup.ts:129-131`, `detect.ts:96` | Partial (message false; interactive path not run) |
| `trent config set provider/model` | Writes the profile | live exit 0 | Works |
| `model-gateway/providers.ts` | Alias resolves to `openai` + `http://127.0.0.1:11434/v1` (`OLLAMA_BASE_URL` overrides); key forced to placeholder `local`; one model into all `OPENAI_MODEL_*` | `providers.ts:50-60,153-194`; probe `applyModelEnv.written` | Works (in isolation) |
| `orchestrator/model-env.ts` | `applyModelEnv` runs inside `createOrchestrator`, which is after the CLI has already evaluated `ai-client.ts`, so its `OPENAI_MODEL_*` writes reach nothing that reads the frozen `MODELS` | `orchestrator/index.ts:151`; freeze probe (section 4) | **Breaks (ordering)** |
| `model-gateway/index.ts` (planner, critic, gateway consolidator) | Alias route re-reads the model per call (`aliasModelFor`), so these calls carry the configured local id | `index.ts:269-298`; fake log `other qwen3:4b`; Ollama log for the live run | Works |
| App client under the alias (`ai-client.ts:403-419`, reached from `index.ts:244-249`) | Streams to Ollama with `include_usage` (the provider is `openai`); **60 s header timeout, SDK maxRetries 2** | `ai-client.ts:117`; Ollama `500 | 59.999s` three times; run exit 1 at 185.6 s | **Breaks for slow local models** |
| `model-gateway/openai-compat.ts` | Used for `google` only; the alias does not use it | `index.ts:220-228` | n/a |
| `complete.ts` / `attempts.ts` | Usage collected; `providerAlias: "ollama"` on every record | probe `default.complete` | Works |
| `retry.ts` | openai-node's "Request timed out." is classed `internal`, so it is not retried by Trent | `retry.ts:184`; stderr `"errorClass":"internal"` | Degraded |
| `call-policy.ts` `planAttempts` | A pinned id is routed by name: `mistral:7b` goes to provider `mistral`, then to api.mistral.ai | `call-policy.ts:107`; app `model-gateway.ts:122-131`; probe 401 | **Breaks + leak** |
| `orchestrator/seat-gateway-port.ts` | Seats go through the wrapper gateway, but `request.model` is the app's frozen `gpt-5.2`/`gpt-4.1-mini`; ids containing `mistral`, `gemini` or `claude` are refused | `seat-gateway-port.ts:62-69,101-104`; fake log `seat gpt-5.2`, `seat gpt-4.1-mini`; probe refusals | **Breaks** |
| App `executeSeatModel` | Tries the 5-provider chain with `resolveModelName(tier, provider)`; for `openai` that returns frozen `MODELS` | app `model-gateway.ts:204-260`, `ai-client.ts:74-77` | **Breaks (via freeze)** |
| App `callText` (consolidator / `ceoChatResponse`) | Bypasses the gateway: `createAIClient()` with `MODELS.DEFAULT` (`gpt-4.1-mini`), non-streaming, unmetered | `ai-client.ts:364-380`, `orchestrator-runtime.ts:562-575`; fake log `other gpt-4.1-mini` | **Breaks (via freeze)** |
| `pricing.ts` | Local alias is priced by `LOCAL_ROW`: 0 cents, `source: local`, `unpriced: false`; the ledger row says `provider: ollama`. A `:cloud` model is also priced 0 | `pricing.ts:144,182`; probe `priceCall`; `spend.ndjson` rows | Works (see G11) |
| Doctor `check_credentials` | `skip`, "runs locally and needs no API key"; no endpoint or model probe | `credentials.ts:53-59`; doctor exit **0** with Ollama unreachable and the model not pulled | Degraded |
| Doctor `check_connectivity` | Resolves `api.openai.com` only | `connectivity.ts:12` | Degraded (irrelevant check) |
| Doctor `check_embedder` | Probes Ollama with `text-embedding-3-small`; a 404 is reported as "could not be reached", with the fix "re-run once reachable" | `doctor/checks/embedder.ts:92-101`; live `"probe":"unreachable"` on HTTP 404 | Degraded (wrong diagnosis) |
| Doctor `Sandbox & Workbench` | Default `terminal.backend: docker`; daemon down, so fail and exit 3 (the REPL itself falls back to local) | `config/defaults.ts:29`; live doctor exit 3 | Degraded (not model-related) |
| `fleet-memory/embedder.ts` | `auto` picks the alias route with the OpenAI default model `text-embedding-3-small`, then 404, then silent lexical; `vectorFloor 0.3` is OpenAI's, uncalibrated for any local model | `embedder.ts:104,206-216,265`; `lexical.ts:159-163`; recall probe | Partial |
| App `wiki-embeddings.ts` | `EMBEDDING_MODEL` default `text-embedding-3-small` to Ollama, then 404, then hash fallback; not switched off by `memory.embedder.provider: none` | `wiki-embeddings.ts:20,106-116`; stderr line every step; 14 calls in the workaround run | Degraded |
| `egress/**` | Not on the model path: model calls run in-process and go direct; sandbox children get `NO_PROXY=localhost,127.0.0.1` | `SandboxEnvironment.ts:46`; no `HTTP(S)_PROXY` write in core/CLI (grep empty); allowlist `terminal.ts:34` | Works (n/a) |
| `tools/media` transcription | whisper.cpp, then faster-whisper, locally; hosted is opt-in | `tools/media/transcribe.ts:1-20` | Works (not exercised) |
| `tools/media` image | `auto` needs a Gemini or OpenAI key; `image_provider: ollama` is accepted, but Ollama `/images/generations` is untested | `tools/media/image.ts:111-147`; doctor Media line | Breaks by default / untested |
| `tools/vision` | Sends `image_url` parts through the gateway; needs a vision-capable local model | `tools/vision/index.ts` (buildVisionMessages) | Untested |
| `improve` judge | Neither `judge_model` nor `models.planner` is set, so it falls back to a priced **Gemini** id (`gemini-3.5-pro`), which Ollama is then asked for | `improve/judge-model.ts:79-86`; `improve-sweep.ts:193-211`; probe | **Breaks by default** |
| REPL banner | Prints "DEGRADED MODE — no model provider key was found" and marks every agent line DEGRADED | `apps/cli/src/repl/degraded.ts:34-36`, `repl/index.ts:175`; both REPL transcripts | Degraded (false) |
| `trent brain import` | Chunks and writes docs; no model or embedding call | live exit 0, 2 imported | Works |
| Recall | Lexical only in effect; the paraphrase query recalls nothing | recall probe | Partial |
| `trent run --json` `models` field, spend ledger | Report `gpt-5.2`/`gpt-4.1-mini` under `provider: ollama` | fake run output; `spend.ndjson` (8 rows) | Degraded (misreport, via freeze) |
| Context window | `contextWindowFor` has no production caller; `LOCAL_ROW` has no window. Seat prompt about 6.2k tokens, planner about 4k (chars/4), plus `max_tokens` 8192. Ollama truncates silently past `num_ctx` | `model-gateway/index.ts:88` (export only); fake log sizes | Risk (unverified) |

## 3. Live check on real Ollama (no cloud)

- **Setup.** `setup --mode quick --provider ollama --model <M>` printed "Setup did not complete: No key found for
  ollama. Set OLLAMA_API_KEY in your environment or in <profile>/.env" (exit 3). It is still exit 3 with
  `OLLAMA_API_KEY=local` set, and `--mode full` from a pipe exits 2. `config set provider ollama` and
  `config set model <M>` both exit 0.
- **Doctor** (exit 3): 22 checks, 11 passed, 4 warnings, 1 failed, 6 skipped. The one failure is
  `Sandbox & Workbench`: "Docker is installed but the Docker daemon is not running". `API Credentials` was a skip.
  `Recall Embedder` was a warn: "Ollama could not be reached for embeddings within 5000ms ... HTTP 404 Not Found:
  model "text-embedding-3-small" not found, try pulling it first".
- **Baseline speed, direct Ollama `/api/generate`, warm:** prompt eval 34.7 tok/s, generation 1.3 tok/s. Trent
  prints no tokens/second figure.
- **`trent run "Write a one-line tagline for a bakery" --json`** (exit 1, real 187.47 s):
  `{"status":"failed","cost_cents":0,"duration_ms":185644,"model":"hf.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:latest","models":[],"error":"planner call failed: internal (Request timed out.); no step ran","total_steps":3}`.
  The Ollama log shows three `POST /v1/chat/completions` returning `500` at 59.99 s, 60 s and 60 s. The prompt
  progressed `n_tokens` 1536 → 2048 → 2560 across the three attempts on the prefix cache, then the SDK ran out of
  retries. stderr also shows `wiki-embeddings: live embedding failed, using fallback — 404 model
  "text-embedding-3-small"` and `orchestrator.llm_failure { stage: 'planner', model: 'gpt-5.2', ... }`. The logged
  `gpt-5.2` is the app's frozen label; the wire carried the local id.
- **REPL, `printf 'list the files in this workspace\r' | trent`** (stdin held open until the run ended; exit 0,
  3 min 20 s). The DEGRADED MODE banner printed, the sandbox fell back to `local (docker unavailable ...)`, and the
  turn ended `✗ Run failed: planner call failed: internal (Request timed out.); no step ran`. With stdin closed
  right after the line, the REPL exits at "Planning..." and makes no model call.
- **Tool calls on the live model:** not reached, because no seat ran. **Cost recorded:** 0 cents, and no ledger row.
- **Fake-server runs (same CLI; `qwen3:4b`; `terminal.backend: local`):**
  - `trent run ... --json` completed, exit 0, in 5.0 s. Planner, critic and gateway consolidator were sent as
    `qwen3:4b`. The seats were sent as `gpt-5.2` (CEO, opus tier) and `gpt-4.1-mini` (sonnet tier). Two
    consolidator calls were `gpt-4.1-mini`, non-streaming and outside the gateway. The result said
    `"models":["gpt-5.2","gpt-4.1-mini"]`.
  - **Tool calls parse.** The seat's `{"toolCall":{"name":"file_ops","action":"search_files {...}"}}` executed on
    the local backend. Turn 2's prompt carried `Prior tool results: file_ops(...) [completed] 2 files match(es)
    ... stock.csv notes.md`, and the REPL showed `· file_ops search_files {...} · completed`. The contract is
    JSON-in-content with the app's `json_object` format dropped (`seat-gateway-port.ts:32-33,76-82`), not native
    function calling, so the model's `tools` capability is irrelevant. Whether a real local model keeps to the
    shape is unmeasured.
  - **Workaround run:** with `OPENAI_MODEL_FAST`, `OPENAI_MODEL_DEFAULT`, `OPENAI_MODEL_STRONG` and
    `OPENAI_MODEL_CRITIC` set to `qwen3:4b` in the environment, it completed (exit 0) and every chat request was
    `qwen3:4b` (10 other, 4 seat). The result said `"models":["qwen3:4b"]`, and the ledger rows were
    `provider: ollama, cents: 0` with real token counts.

## 4. Root cause of the seat break (bisected)

`MODELS` in `apps/web/lib/ai-client.ts:22-52` is evaluated once, at module load. The static import chain is:
`apps/cli/src/commands/*` and `runtime/headless.ts`, then `@trent/core/improve/index.ts`, then
`improve/suite-split.ts:24`, then `gepa/index.ts:16` (`import ... from "@/lib/gepa"`), then
`apps/web/lib/gepa.ts:31` (`import { MODELS, ... } from "@/lib/ai-client"`). That chain evaluates `ai-client.ts`
when the CLI starts, long before `createOrchestrator` calls `applyModelEnv` (`orchestrator/index.ts:151`).

Probe result: importing `@trent/core/gepa/index.js`, `improve/index.js`, `runtime/headless.ts` or
`commands/index.ts` first leaves `MODELS.STRONG === "gpt-5.2"` after `OPENAI_MODEL_STRONG` is written. The core
modules `orchestrator`, `fleet-memory`, `tools`, `store`, `cron`, `model-gateway` and `evals` do not freeze it.

Google and Mistral escape because `resolveModelName` reads their variables per call (`ai-client.ts:66-72`). By
the same mechanism, not run here, a configured `model:` for `openai` or `anthropic` would also not reach seats.

## 5. Embeddings and retrieval without a cloud key

- `trent brain import <dir>` exits 0: 2 docs, 1 chunk each, no model or embedding call. `trent brain docs` lists
  them.
- Recall (`recallFromBrain` on that profile): the embedder selection is
  `{"provider":"openai","label":"Ollama","model":"text-embedding-3-small","baseUrl":"http://127.0.0.1:11434/v1","reason":"configured"}`.
  Every embed call is an HTTP 404, which `lexical.ts:159-163` swallows into lexical-only.
  - "what time does the bakery open on saturday" recalls `hours#1`, for both rankers.
  - "discount for coffee shops ordering bread in bulk" recalls `[]` for both. This is the paraphrase case hybrid
    ranking exists for.
- With `memory.embedder.provider: none` the wrapper stops calling, but the app's `wiki-embeddings` still calls
  `/v1/embeddings` on every step. A local embedding model (e.g. `memory.embedder.model: nomic-embed-text`) is
  selectable (`dims 0`, floor 0.3 uncalibrated), but is untested because none is pulled.

## 6. Gap list

Severity: B = breaks, D = degrades, R = risk (unverified).

| # | Sev | Where | Smallest fix | Failing test that defines done |
|---|---|---|---|---|
| G1 | B | `gepa/index.ts:16` → `apps/web/lib/gepa.ts:31` freezes `ai-client.ts:22-52` before `orchestrator/index.ts:151` | Apply the profile's model env before any static import: load the active profile's config in `apps/cli/src/env-defaults.ts` (already imported first) and call `applyModelEnv`. Belt and braces: make `gepa/index.ts` load `@/lib/gepa` lazily | Fresh module graph with `TRENT_HOME` config `provider: ollama, model: qwen3:4b`: import `apps/cli/src/commands/index.ts`, then `resolveModelName("opus","openai")` must be `qwen3:4b` (today `gpt-5.2`). E2E: `trent run` against a fake OpenAI server, every `/v1/chat/completions` model is `qwen3:4b` |
| G2 | B | `ai-client.ts:117` 60 s timeout, reached via `model-gateway/index.ts:244-249` | Stream alias providers through the Trent-side streamer (generalise `openai-compat.ts` beyond Google) with a configurable headers timeout, longer by default for local aliases | Gateway on the `ollama` alias against a fake server that sends headers after longer than 60 s (scaled via `headersTimeoutMs`) completes; today "Request timed out." |
| G3 | B | `setup/detect.ts:20-21`, `QuickSetup.ts:32-43` | Quick setup: when `--provider` is keyless, skip key detection and write the config (optionally probe the endpoint) | `SetupWizard.test.ts`: quick, `provider: "ollama"`, empty env gives `success: true`, `config.provider === "ollama"` (today `reason: "no-key"`) |
| G4 | B + leak | `seat-gateway-port.ts:62-69,101-104`; `call-policy.ts:107` + app `inferProviderFromModel` | While `activeProviderAlias()` is set, infer every model id to the alias's provider in both the seat port and the gateway's `inferProvider` | Alias `ollama` with an injected `streamProvider`: `seatPort({model:"mistral:7b"})` and `gw.complete({model:"mistral:7b"})` both reach provider `openai` with model `mistral:7b`; never `mistral` |
| G5 | B (via G1) | app `callText` `ai-client.ts:364-380`, `orchestrator-runtime.ts:562-575` | Fixed for the model id by G1; stays unmetered and outside the gateway | G1's e2e also asserts the consolidator requests carry `qwen3:4b` |
| G6 | B | `improve/judge-model.ts:79-86` | For a non-Google provider, do not fall back to the Gemini table; throw `EXIT.CONFIG` naming `improve.judge_model` | `resolveJudgeModel({executor:"qwen3:4b", provider:"ollama"})` throws naming `improve.judge_model` (today returns `gemini-3.5-pro`) |
| G7 | D | `repl/degraded.ts:34-36`, `repl/index.ts:175` | `isDegraded(source, provider)` is false for `KEYLESS_ALIASES` | `isDegraded({}, "ollama") === false` |
| G8 | D | `doctor/checks/credentials.ts:53-59` | For keyless providers, `GET {aliasBaseUrl}/models`; fail if unreachable or the configured model is absent, with the hint `ollama pull <model>` | Doctor with a fake fetch: unreachable gives fail; model list without the configured id gives fail (today skip, doctor exit 0) |
| G9 | D | `fleet-memory/embedder.ts:206-216,265`; `doctor/checks/embedder.ts:92-101` | A local alias with no `memory.embedder.model` resolves to `none` (honest lexical); doctor classes 404 as "model not pulled" | `selectEmbedderProvider({provider:"ollama"},{})` has `provider === "none"`; doctor on a 404 names the model and `ollama pull` |
| G10 | D | app `wiki-embeddings.ts:20,106-116` | Bridge `memory.embedder.model` into `EMBEDDING_MODEL` when an alias is active | After `applyModelEnv` for `ollama` with `memory.embedder.model: X`, `process.env.EMBEDDING_MODEL === "X"` |
| G11 | D | `pricing.ts:182`, `credentials.ts:53-56` | Treat `:cloud`/`-cloud` ids as not local: not priced at 0; doctor warns that prompts leave the machine | `priceCall({model:"nemotron-3-ultra:cloud", alias:"ollama"}).source !== "local"` |
| G12 | D | `config/defaults.ts:29` + doctor sandbox check | Doctor warns rather than fails when the runtime will fall back to the local backend | Doctor with the Docker daemon down and backend `docker` gives warn, exit 0 |
| G13 | D | `doctor/checks/connectivity.ts:12` | For a local alias, probe the alias base URL instead of `api.openai.com` | Offline machine with Ollama up gives ok |
| G14 | D (via G1) | run result `models`, `spend.ndjson` `model` | Fixed by G1 | Ledger rows for an ollama run name the configured model |
| G15 | D | `setup/FullSetup.ts:129-131` via `detect.ts:96` | Say "no key needed for a local runtime" | Full setup scripted with `ollama` has no "is already set" line |
| G16 | D | `model-gateway/retry.ts:184` | Class openai-node's `APIConnectionTimeoutError` as `timeout` | `classifyProviderError(new APIConnectionTimeoutError())` returns `errorClass: "timeout"` |
| G17 | R | `LOCAL_ROW` has no window; `contextWindowFor` unused | Doctor reads `/api/show` `num_ctx` and compares it to the measured seat prompt (about 6.2k tokens plus 8192 output) | Fake `/api/show` with `num_ctx` 4096 gives a doctor warn |
| G18 | R | `improve/judge.ts:63` (256 max tokens); thinking models | Measure on a live thinking model; raise the budget or request no thinking | Live: judge reply parses with `qwen3:4b` |

## 7. Minimum local config today, and what the user sees

```yaml
# ~/.trent/config.yaml (written with `trent config set`; quick setup refuses ollama)
provider: ollama
model: <a pulled Ollama model id not containing mistral/gemini/claude>   # G4
terminal:
  backend: local            # only when Docker is not running (G12)
memory:
  embedder:
    provider: none          # honest lexical ranking (G9); or model: <a pulled embedding model>
improve:
  judge_model: <a second pulled local model>   # only for `trent improve sweep --live` (G6)
```

The following must also be exported in the shell before launch (G1 workaround, verified against the fake server):
`OPENAI_MODEL_FAST`, `OPENAI_MODEL_DEFAULT`, `OPENAI_MODEL_STRONG` and `OPENAI_MODEL_CRITIC`, each set to the
model, and `OLLAMA_BASE_URL` if the server is not on the default. On a slow machine, a model whose prompt
evaluation of about 4k tokens exceeds 60 s still fails (G2); a small model is needed.

Messages seen:

- `trent setup` prints "Setup did not complete: No key found for ollama. Set OLLAMA_API_KEY ..." (exit 3).
- `trent doctor` shows:
  - `· API Credentials  Provider "ollama" runs locally and needs no API key.`
  - `◆ Recall Embedder  Ollama could not be reached for embeddings ... 404 ... text-embedding-3-small`, or a skip
    with `provider: none`.
  - `✗ Sandbox & Workbench` only when Docker is down.
- The REPL prints the DEGRADED MODE paragraph on every launch.

## 8. Commands run (exit codes)

Here `T` means the isolated runner: `env -i PATH=... HOME=<scratch>/home TRENT_HOME=<scratch>/trent-home
TRENT_QUEUE_FALLBACK=disabled TSX_TSCONFIG_PATH=<repo>/tsconfig.json node_modules/.bin/tsx apps/cli/src/index.ts`,
run from `<scratch>/ws` (two files). `T-fake` is the same runner on a second profile
(`qwen3:4b`, `terminal.backend: local`) with `OLLAMA_BASE_URL` pointing at the fake server.

| Command | Exit |
|---|---|
| `git rev-parse --short HEAD` → `412f5b0` | 0 |
| `which ollama` / `curl 127.0.0.1:11434/api/version` → `0.32.9` | 0 / 0 |
| `curl 127.0.0.1:1234/v1/models` (LM Studio) / `which lms` | 7 / 1 |
| `ollama list`; `ollama show <both 27B models>`; `ollama ps` | 0 |
| `T --version` → `1.0.0`; `T setup --help` | 0; 0 |
| `T setup --mode quick --provider ollama --model <M> </dev/null` (text, `--json`, and with `OLLAMA_API_KEY=local`) | 3, 3, 3 |
| `T setup --mode full --provider ollama --model <M> </dev/null` | 2 |
| `T config set provider ollama`; `T config set model <M>` | 0; 0 |
| `T doctor`; `T doctor --json` | 3; 3 |
| `curl .../api/generate` (cold, then warm baseline) | 0; 0 |
| `T run "Write a one-line tagline for a bakery" --json` (real 187.47 s) | 1 |
| `printf 'list the files in this workspace\r' \| T` (stdin held to run end; turn failed at planner) | 0 |
| `tsx fake-ollama-probe.ts` (gateway, seat port, judge, pricing, embedder; includes the unintended Mistral request) | 0 |
| `T-fake config set provider ollama / model qwen3:4b / terminal.backend local` | 0 |
| `T-fake run "Write a one-line tagline for a bakery" --json` | 0 |
| `printf ... \| T-fake` (first: stdin closed early, stopped at "Planning..."; second: full turn) | 0; 0 |
| `T-fake run "list the files in this workspace" --json` (turn-2 prompt captured) | 0 |
| `tsx freeze-probe.ts <module>` (first attempt: esbuild refused top-level await in a `.ts` outside the ESM scope, so no result) | 1 |
| `tsx freeze-probe.mts <module>` over: 10 core entry points, every non-test file of `apps/cli/src/commands/**` and of `improve/`, `runtime/headless.ts` and `gepa/index.ts` (results in section 4) | 0 each |
| `T-fake brain import <docs>`; `T-fake brain docs` | 0; 0 |
| `tsx recall-probe.mts` | 0 |
| `T-fake doctor --json` with `OLLAMA_BASE_URL=http://127.0.0.1:9/v1`, `qwen3:4b` not pulled | **0** |
| `T-fake config set memory.embedder.provider none`; `T-fake run ... --json` with `OPENAI_MODEL_*=qwen3:4b` | 0; 0 |

## 9. Not verified

- A live run on a small local model (needs Bobby's OK to `ollama pull qwen3:4b`, about 2.5 GB).
- Whether a real local model emits the seat's JSON tool-call shape reliably.
- Thinking-token budgets (G18).
- Ollama `num_ctx` truncation (G17).
- LM Studio, which was not running.
- Local vision and image generation.
- The G1 effect on `openai`/`anthropic` providers (inferred from the same code; not run).
- Session log: not appended, because this task permitted a single write. The parent session owns
  `docs/sessions/2026-09-26-*`.
