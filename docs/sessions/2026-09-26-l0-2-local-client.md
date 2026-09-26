# 2026-09-26 — L0-2: the wrapper's own client for every OpenAI-compatible provider, local budgets

Branch `feature/trent-fleet-v2`, HEAD `412f5b0` at start. Agent L0-2 of the L0 wave
(`02_plan/output/local-models-plan-2026-09-26.md`). Gaps owned: G2, G16, G17 from
`01_discovery/output/trent-local-path-audit-2026-09-26.md`, plus the in-flight cap (research §8.1 G6).
No commit, stash, checkout or push (orchestrator's rule for this wave). No cloud model call.

## Lane
Own: `model-gateway/{openai-compat,index,attempts,retry,providers,types,complete}.ts` (+tests),
`config/sections/models.ts` (one `// [L0-2] local` block), `fleet-memory/prompt-budget.ts` (+test),
one marked call in `fleet-memory/orchestrator-hook.ts`, `docs/configuration.md` lines for my keys.
Not mine: call-policy, pricing, seat-gateway-port, model-env, env-defaults (L0-1); setup, repl,
improve (L0-3); doctor (L0-4); embedder (L0-5).

## Log

### Baseline
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/model-gateway packages/trent-core/src/config`
  -> exit 0, 20 files, 187 tests.

### Facts checked against the runtimes' own docs (curl of the raw pages, 2026-09-25 local date)
- Ollama `/v1/chat/completions` (https://docs.ollama.com/api/openai-compatibility): supported fields
  include `stream_options.include_usage` and `reasoning_effort`; "reasoning_effort and reasoning.effort
  control model thinking. Use /api/show to discover each model's supported values". So Ollama does
  NOT ignore or reject it (the brief's premise); it is sent when `/api/show` lists `thinking`.
- llama.cpp server README (tools/server/README.md): "`reasoning_effort`: If `none`, reasoning/thinking
  is disabled. Otherwise, the value is made available to the jinja template." Also accepted.
  `/props` -> `default_generation_settings.n_ctx`, `total_slots`; usage carries
  `prompt_tokens_details.cached_tokens`, and `timings.cache_n`.
- LM Studio chat completions (https://lmstudio.ai/docs/developer/openai-compat/chat-completions):
  supported payload is model, top_p, top_k, messages, temperature, max_tokens, stream, stop,
  presence_penalty, frequency_penalty, logit_bias, repeat_penalty, seed. No `reasoning_effort`, so
  not sent. `GET /api/v1/models` -> `loaded_instances[].config.context_length`; v0
  `GET /api/v0/models/{model}` -> `max_context_length`. Max Concurrent Predictions default 4
  (https://lmstudio.ai/docs/app/advanced/parallel-requests).
- Ollama concurrency (https://docs.ollama.com/faq): "OLLAMA_NUM_PARALLEL - The maximum number of
  parallel requests each model will process at the same time, default 1." Context
  (https://docs.ollama.com/context-length): < 24 GiB VRAM 4k, 24-48 GiB 32k, >= 48 GiB 256k.
- Live, local metadata only (no generation): `GET /api/ps` on Ollama 0.32.9 returns
  `context_length: 32768` for the loaded `qwen3.5:9b`; `POST /api/show` returns
  `qwen35.context_length: 262144` (the trained maximum, NOT the window) and capabilities
  `completion, vision, tools, thinking`. So the window is read from `/api/ps` first.
- Node's global fetch (undici) has a 300 s headers timeout of its own, so a TTFT budget above 300 s
  is not honourable through `fetch`; local routes use `node:http` instead (no built-in timeout).
- openai-node 4.104.0 `APIConnectionTimeoutError` ("Request timed out.") has no `name` of its own
  and no status: that is why `retry.ts` classed it `internal` (G16).

### RED (before any production change)
- New/extended tests: `model-gateway/{local-client,local-timeouts,local-runtime,local-probe}.test.ts`,
  `retry.test.ts` + `ModelGateway.retry.test.ts` (G16), `fleet-memory/prompt-budget.test.ts`,
  `config/models-local-schema.test.ts`.
- Run 1 (no new modules): G16 red for the right reason: `expected { errorClass: 'internal' } to match
  { errorClass: 'timeout' }`; gateway retry `expected [ 'google' ] to deeply equal [ 'google', 'google' ]`.
  The rest: module not found.
- Run 2 (interface shells only, no behaviour): every alias and `openai` -> `Connection error.` (the app
  client ignored the gateway's fetch seam and hit 127.0.0.1:9, where nothing listens: no leak);
  concurrency `expected 3 to be 1`, `expected 4 to be 2`; cancelled-in-queue `expected 2 to be 1`;
  hook `expected true to be false` (a 6K-token seat prompt was sent into a 4K window);
  timeouts `expected 'Connection error.' to match /300 s/`, `/openai request sent no response headers within 60000ms/`.

### GREEN, in order
1. `retry.ts`: openai-node's `APIConnectionTimeoutError` (class name, or its fixed "Request timed out."
   message) is `timeout`; every timeout carries `maxAttempts: 2` (retried once); `attempts.ts` honours it.
   `retry.test.ts` + `ModelGateway.retry.test.ts` -> exit 0, 36 tests.
2. `local-runtime.ts` (new): `models.local` defaults (300 s / 120 s / 32768 / Ollama 1, LM Studio 4),
   the `TRENT_LOCAL_*` env bridge, a process-wide per-endpoint FIFO slot queue (abort leaves it), and
   `localFetch` over `node:http(s)` (no 300 s undici cap).
3. `local-probe.ts` (new): window from Ollama `/api/ps` -> `/api/show num_ctx`, LM Studio
   `/api/v1/models`, llama.cpp `/props`, else `context_tokens` capped by the trained maximum; reported
   windows cached per process; Ollama capabilities from `/api/show`. `local-probe.test.ts` 8/8.
4. `openai-compat.ts`: one streamer (`streamCompatChat`) for every OpenAI-compatible route; hosted =
   60 s headers budget as before; local = TTFT deadline until the first content/reasoning/tool delta,
   then an idle deadline re-armed on every read; both throw `TimeoutError` naming the budget and the
   `models.local.*` setting. llama.cpp `timings.cache_n` fills a missing cached count.
   `streamGoogleCompatChat` kept as a wrapper (label `google`).
5. `openai-route.ts` (new): `openai` and its aliases: key/base URL/org/project from the app's own
   variables, body tuning from the app's `modelChatTuning`, `reasoning_effort` per provider docs
   (OpenAI reasoning models; Ollama when `/api/show` lists `thinking`; never LM Studio/DeepSeek/Groq),
   local slot then stream. `index.ts` routes `provider === "openai"` there (one branch).
   `npx vitest run packages/trent-core/src/model-gateway` -> exit 0, 14 files, 172 tests.
6. `config/sections/models.ts`: `// [L0-2] local` block; fixture keys added to
   `schema-split.input.json`; `npx tsx scripts/dev/regen-snapshot.mjs` exit 0, snapshot diff = only
   the new block.
7. `fleet-memory/prompt-budget.ts` (new) + the hook: the `placeTiers` line now goes through
   `fitSeatPrompt` (dynamic import on that same line: the hook is at the 500-line ceiling, 499 lines,
   so an import line would break `wrapped-modules.test.ts`). prompt-budget + schema tests exit 0, 15.
8. `apps/cli/src/runtime/headless.ts`: `applyLocalModelEnv(config.models.local)` next to the privacy
   bridge (the natural home, `model-env.ts`, is L0-1's). RED first:
   `headless.local-models.test.ts` `expected undefined to be '900'`.
9. `docs/configuration.md`: Providers intro, `reasoning_effort` paragraph (was "Google calls only",
   now false), new "Local models" subsection, retry-once line.

Note: load average reached 570 during this session (six agents' test runs); vitest runs slowed to minutes.

### Found in self-review and fixed, red first
- A consumer that `break`s out of `gateway.stream()` after a token (no abort, no failure) left the
  upstream generator suspended: its socket open and, on a local route, its in-flight slot held for
  good. `attempts.ts` now calls `return()` whenever the upstream did not reach its end. RED:
  `local-runtime.test.ts` "a consumer that stops reading after its first token frees the slot"
  -> `expected 'still queued' to be 'ok'`; GREEN with the fix, gateway 14 files / 173 tests exit 0.
- The hook call first used `await import("./prompt-budget.js")` on the `placed` line (no free line
  for an import at 499 lines). `interrupted.test.ts` caught it: the step was untracked, and the seat
  fn not yet called, for longer than the one macrotask the test allows. Fixed by a STATIC import
  (the `./tiers.js` import's two `type` names joined on one line to make room) and moving the call
  into the `try` after `interrupted.begin`, so a refused call settles as not completed. Hook diff vs
  HEAD: that joined line, the import, and the one call line; 499 lines.
- docs-truth read my inline `` `/props` `` as a REPL slash command; now `` `GET /props` ``.
- `apps/cli` typecheck: `Headers.entries()` is untyped there (no DOM.Iterable); `forEach` instead.

### Verification (load average 170-890 throughout; six agents)
- `node scripts/ci/repo-scan.mjs` -> exit 0 (0 canned, 0 hex, 0 emoji; 1122 files).
- `cd packages/trent-core && npm run build` -> exit 0 (an earlier run: exit 2 on L0-1's
  `local-routing.test.ts:153`, since fixed by them).
- `cd apps/cli && npm run typecheck` -> exit 0.
- Full brief set, first run: 9 failed / 746 passed (92 files), exit 1. Mine: docs-truth `/props` and
  `interrupted.test.ts` (both fixed above). Not mine: `embedder-local.test.ts` (L0-5, in progress);
  `schema-split` (three agents regenerating the snapshot; passes on rerun); timeouts under load:
  seat-wiring (60 s), orchestrator.concurrency (120 s), orchestrator.resume and app-memory.bun
  (setup hooks), ingest/extract PDF (60 s; pass on rerun).

### The one real timing run (local only, no cloud)
- Model: `qwen3.5:9b`, the only local chat model under 16 GB; `ollama list` says 6.6 GB
  (6,601,687,693 bytes), ABOVE the brief's 6 GB line (the plan's "~5.7 GB" is the HF GGUF size).
  Run anyway as the plan's chosen small model; flagged in the report. It had been evicted, so the
  run includes a cold load. Load average 170-890 throughout (other agents' test runs).
- Scratch profile (`scratchpad/live`, `env -i`, scratch HOME and TRENT_HOME, no keys inherited):
  `config set provider ollama` / `model qwen3.5:9b` / `terminal.backend local` -> exit 0 each.
- `trent run "Say ready" --json` -> exit 1, `real 1022.20` s. Result: `"status":"failed"`,
  `"error":"the run stopped on an error: Job job_62sfvtcjevx8 timed out after 600000ms; 0 of 2 steps
  completed; consolidation skipped"`, `cost_cents 0`.
- Trent prints no TTFT or tokens/s; llama-server's own lines (`~/.ollama/logs/server.log`) give them:
  - planner: prompt 3,773 tokens, prefill 91.09 s (41.4 tok/s) = time to first token ~91 s (plus the
    cold load); 893 tokens decoded at 3.04 tok/s; `POST /v1/chat/completions` 200 in 6m54s.
    Under the app client's 60 s this call died (audit G2); through the wrapper's client it completed.
  - budget probe: `GET /api/ps` 23:13:32 (window 32,768; seat prompt fits, `truncated = 0`).
  - seat: prompt 5,935 tokens, prefill 157.39 s (37.7 tok/s) = TTFT ~157 s; 1,267 tokens decoded at
    2.99 tok/s (thinking; `reasoning_effort` unset) until the app's job timeout closed it at 9m57s.
- What stopped it: the APP's per-job timeout, `apps/web/lib/queue.ts` `DEFAULT_JOB_TIMEOUT_MS`
  (10 min; env `TRENT_JOB_TIMEOUT_MS`), not a gateway budget. Follow-ups, not in this lane: size that
  timeout for a local run; `models.reasoning_effort: none` now reaches Ollama for a `thinking` model
  (this change), which should cut the 1,267 thinking tokens; 3 tok/s decode on an M1 Max is contention.

### Final state (2026-09-25 23:27 local)
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/model-gateway packages/trent-core/src/fleet-memory packages/trent-core/src/config packages/trent-core/src/orchestrator apps/cli/src/commands/__tests__/docs-truth.test.ts packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 0, 92 files, 764 tests.
- The load-timeout suites, alone, with this change in the tree: `seat-wiring.test.ts` exit 0 (2),
  `orchestrator.resume.test.ts` exit 0 (4); `orchestrator.concurrency.test.ts` passes with
  `--testTimeout=900000` (119.2 s against its 120 s default).
- `npx vitest run apps/cli/src/runtime/headless.local-models.test.ts apps/cli/src/runtime/headless.model.test.ts` -> exit 0, 5 tests.
- `node scripts/ci/repo-scan.mjs` -> exit 0.
- `cd packages/trent-core && npm run build` and `cd apps/cli && npm run typecheck`: exit 0 at 23:01
  with this lane complete; a final rerun after a comment-only edit to `types.ts` -> exit 2, 8 errors, all
  in files other agents are editing now (`governance/auto-review-policy.test.ts`, `solo/taint.test.ts`,
  `tools/mcp/http-oauth-wire.ts`); none in a file of this lane.
- Nothing committed, staged or stashed.

### Open, not in this lane
1. The app's per-job timeout (10 min, `TRENT_JOB_TIMEOUT_MS`) ended the live run; a local run needs it sized.
2. The app's `callText` (consolidator) still uses `createAIClient()` with its 60 s timeout, outside the
   gateway (audit G5), so a slow local consolidator can still die at 60 s.
3. `trent heartbeat` and `trent improve` build their own gateways without the headless bridge: they get
   the `models.local` defaults, not the configured values.
4. `mistral` and `openrouter` stay on the app's streamer (no `include_usage`; the SDK's 60 s and two
   retries); moving them needs their own request-shape check.
