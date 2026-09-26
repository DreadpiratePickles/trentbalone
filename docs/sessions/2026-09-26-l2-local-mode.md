# 2026-09-26 — L2: `trent setup --mode local` and docs/local-models.md

Agent L2 (Opus), wave L2 of `02_plan/output/local-models-plan-2026-09-26.md` ("the product path").
Branch `feature/trent-fleet-v2`, HEAD `f90cf41` (L0-3 landed). No commit, stash, checkout or push; no
subagents; no cloud model call; pull nothing; one live setup run at the end only if `uptime` load < 40.
Other agents edit the tree concurrently (S2 apps/cli runtime/commands/repl, H1 governance, H2 tools/mcp +
connect, S1.1 solo, H3 webhooks + config/sections/gateway.ts; L0-1, L0-2, L0-5 landing in the background).

Owned: `packages/trent-core/src/setup/**` (extend L0-3's local-tiers/local-runtime/local-setup, do not
rewrite), `apps/cli/src/commands/groups/diagnostics.ts` (only the `--mode local` wiring, marked `// [L2]`),
`apps/cli/src/commands/__tests__/setup-local.test.ts`, `docs/local-models.md` (new) plus its row in
`docs/README.md` and one row in README's documentation table, the "Local models" section of
`docs/getting-started.md`, this log.

## Read first
Rulebook, AGENTS.md, CONTEXT.md; the plan (L2); local-models research §1, §2, §3, §6 and the §8
checklist; the L0-3 log and its code (`local-tiers.ts`, `local-runtime.ts`, `local-setup.ts`,
`QuickSetup.ts`, `SetupWizard.ts`, `types.ts`); the landscape log (L0 reports); the audit §7; the L0-2,
L0-4, L0-5 logs for the measured numbers and the settings they add.

## Facts checked before code
- This machine: `sysctl hw.memsize` 34359738368 (32 GiB, tier `32gb`, recommended `qwen3.6:27b`, not
  pulled). Ollama 0.32.9 at 127.0.0.1:11434; `/api/tags` lists `qwen3-embedding:0.6b` (639150858 bytes,
  capabilities `embedding`), `qwen3.5:9b` (6594474711, `vision completion tools thinking`),
  `qwen3.8-27b-abliterated:latest` (16810716574, `completion` only: no tools), an hf.co 27B
  (`completion vision`), `nemotron-3-ultra:cloud` (389 bytes: a cloud model). Ollama 0.32.9 puts
  `capabilities` on every `/api/tags` entry; older versions do not, so `/api/show` is the fallback.
- LM Studio at :1234: curl exit 7 (not running). Nothing on :8080 (HTTP 000). Docker 29.5.3 answers
  (`docker info` exit 0, 1.1 s).
- LM Studio `GET /api/v1/models` (https://lmstudio.ai/docs/developer/rest/list, raw page read
  2026-09-26): `models[]` with `type` (`llm` | `embedding`), `key`, `size_bytes`, `params_string`,
  `quantization.name`, `capabilities.trained_for_tool_use`, `capabilities.reasoning`.
- llama.cpp `llama-server` (tools/server/README.md, raw, read 2026-09-26): `GET /v1/models` "always has
  one single element", `meta.size` and `meta.n_params`; `GET /props`; `--reasoning [on|off|auto]`,
  `--reasoning-budget N` (0 ends thinking at once); `reasoning_effort: none` per request disables
  thinking. The gateway (L0-2, `model-gateway/openai-route.ts`) sends `reasoning_effort` on the Ollama
  route only when `/api/show` lists `thinking`, and never on the `lmstudio` route, which is how a
  llama-server is reached; so setup writes `models.reasoning_effort: none` for Ollama thinking models only.
- Dependencies on unlanded work: `memory.embedder.provider: ollama|lmstudio` needs L0-5's
  `config/sections/memory.ts` enum (uncommitted in the tree); `models.local` (docs only) is L0-2's.

## Log
### Baseline (before any change)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/setup apps/cli/src/commands/__tests__/setup-local.test.ts`
-> 4 files, 45 tests passed.

### RED (tests first; `types.ts` fields added and skeleton `local-detect.ts` / `local-plan.ts` /
`LocalModeSetup.ts` that find nothing and refuse, so the failures are behaviour, not imports)
New `setup/local-mode.test.ts` (13 tests) + `setup/local-fakes.test-helpers.ts` (fake Ollama, LM Studio
and llama.cpp at their own origins, documented routes and shapes), 3 new cases in
`commands/__tests__/setup-local.test.ts` (a real `node:http` server playing Ollama; PATH at an empty dir
so `docker` is absent). Run: `npx vitest run packages/trent-core/src/setup/local-mode.test.ts
apps/cli/src/commands/__tests__/setup-local.test.ts` -> exit 1, 16 failed, 2 passed (L0-3's):
- core: `local mode is not built yet: expected false to be true` (10), `expected 'runtime-unreachable' to
  be 'model-not-pulled'`, `expected 'local mode is not built yet' to contain 'http://127.0.0.1:11434'`,
  `... to contain 'http://127.0.0.1:8080'`.
- CLI: `expected 2 to be +0` (twice) and `expected 2 to be 3`: Commander refuses `--mode local`
  (`--mode must be quick, full or blank-slate`) and the unknown `--base-url` / `--fleet`.

### GREEN (implementation)
- `setup/local-detect.ts` (new): probes Ollama and LM Studio at the gateway's URLs plus `--base-url`,
  identifies each by what answers (`/api/version`, `/props`, `/api/v1/models`, `/v1/models`), lists models
  with size, role (chat | embedding | cloud) and capabilities; `/api/show` when `/api/tags` has none.
- `setup/local-plan.ts` (new, pure): runtime choice (`--base-url` wins, then `--provider`, then Ollama,
  then LM Studio), chat choice (tier model; else a smaller tier's pulled model with the line to move up;
  a llama.cpp server's one model; never a cloud model or one listed without `tools`), embedder choice
  (`qwen3-embedding:0.6b` > other Qwen3-Embedding > `nomic-embed-text`, chat runtime first; none ->
  `provider: none`), the alias base URL for the profile `.env`, the dotted writes, `applyLocalWrites`.
- `setup/LocalModeSetup.ts` (new): the run (print, `--pull` per missing model after a confirmation,
  re-probe after a pull, thinking decision, Docker, writes, `--dry-run`); `setup/docker-probe.ts` (new,
  `docker info` on the PATH of the wizard's env).
- `QuickSetup.ts`: the toolset block moved unchanged into exported `quickToolsets(ctx)` so local mode
  writes the same toolsets; `SetupWizard.ts`: `case "local"`, and a local dry run skips `ensureDirs` and
  the heartbeat checklist; `types.ts`: `local` mode, `baseUrl`/`fleet`/`dryRun`, `localDiscovery`,
  `dockerPresent`, `SetupResult.local`; `local-runtime.ts`: `describeProbeFailure` exported (was private).
- CLI `commands/groups/diagnostics.ts` (`// [L2]` hunks only): `--mode local`, `--base-url`, `--fleet`,
  the local dry run goes to the wizard, the summary carries `local` (the plan), a dry-run render line.
- `npx vitest run packages/trent-core/src/setup` -> 4 files, 56 tests (2 + 18 + 23 + 13), exit 0. `npx vitest run apps/cli/src/commands/__tests__/setup-local.test.ts` -> 5 tests, exit 0.
- Wording checked in a scratch transcript (32 GB, the 9B pulled): the Docker line first claimed agent
  commands were "each behind the approval gate", which nothing here verified; replaced with what
  docs/terminal.md says (host environment, not a sandbox).

### Docs
- New `docs/local-models.md` (209 lines): the three hardware tiers (research §6) with the exact models,
  runtimes and URLs; what setup proposes per memory; clean machine to a first solo turn (Ollama, LM
  Studio, llama.cpp); what `--mode local` does and writes (the key table, the stops, the JSON shape,
  what `--dry-run` sends); the measured numbers from the L0-2/L0-3/L0-4 logs, labelled as contention
  numbers; the doctor's Local Model check; the settings; the known limits (context, thinking, the app's
  10-minute job timeout, the tool-call format, heartbeat/improve gateways); escalation "planned, not
  built" with today's two-profile answer. The solo surfaces are stated as S2's, landing now, matching
  configuration.md "Agent mode" (no surface reads `agent.mode` at HEAD).
- `docs/README.md`: one line under "Start". `README.md`: one row in the documentation table, nothing
  else (the "28 pages" proof comment under the table is now one short; it is shared with S2, not mine
  to edit). `docs/getting-started.md` section 11: a paragraph pointing at local-models.md and two
  `--mode local` lines in its command block; the tier table and expectations L0-3 drift-tests are kept.

### VERIFY (final, repo root, `TRENT_QUEUE_FALLBACK=disabled`)
- `npx vitest run packages/trent-core/src/setup apps/cli/src/commands/__tests__/setup-local.test.ts
  apps/cli/src/commands/__tests__/behaviour.test.ts apps/cli/src/commands/__tests__/docs-truth.test.ts
  packages/trent-core/src/wrapped-modules.test.ts` -> **exit 1**, 8 files, 113 passed, 1 failed: docs-truth
  "states the command counts the registry actually has", `expected [ 35, 151 ] to deeply equal [ 36, 152 ]`.
  That is README's command-count line, S2's (its `trent solo` is the 36th command); L2 adds no command.
  Every setup, setup-local, behaviour and wrapped-modules test passes.
- `cd packages/trent-core && npm run build` -> **exit 2**: 19 errors, all in another agent's new
  `gateway/platforms/{line,matrix,mattermost}.wire.test.ts`; none under `setup/`. (An earlier run the
  same hour: 2 errors, both H3's `gateway/WebhookServer.test.ts` and `webhooks/serve.test.ts`.)
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> **exit 0** (an earlier run: exit 2, 8 errors, all in
  S2's `gateway/agent-handler.solo.test.ts`). My CLI test first built a `Request` with a `Buffer` body,
  the pattern that fails H3's typecheck; changed to a string before it was ever reported.
- `node scripts/ci/repo-scan.mjs` -> **exit 0**.
- Every file touched is under 500 lines (largest: `local-plan.ts` 264, `diagnostics.ts` 262).

### LIVE: skipped
`uptime` at 00:00 local: load averages 294.57 190.69 211.85 (the gate is under 40), so the one allowed
live setup run was not made. What `--mode local` would write on this machine is derived from this
machine's real `/api/tags` listing (curl, above) run through the same code with a fake fetch in a
scratch transcript: provider `ollama`; model `qwen3.5:9b` (source `fallback`: the 32 GB tier's
`qwen3.6:27b` is not pulled, and the line `ollama pull qwen3.6:27b` is printed); `memory.embedder`
`ollama` / `qwen3-embedding:0.6b`; `agent.mode: solo`; `models.reasoning_effort: none` (the 9B lists
`thinking`); `terminal.backend` unchanged because Docker 29.5.3 answers here. `qwen3.8-27b-abliterated`
and the hf.co 27B are listed "chat, no tools", `nemotron-3-ultra:cloud` as a cloud model, never chosen.

### Dependencies at landing
- `memory.embedder.provider: ollama|lmstudio` is accepted only with L0-5's `config/sections/memory.ts`
  enum (uncommitted): at HEAD `f90cf41` alone, `saveConfig` would refuse the write. Land L2 after L0-5.
- docs/local-models.md cites `models.local.*` (L0-2) and the embedder keys (L0-5) as documented in
  configuration.md; both sections are in the tree, uncommitted.
- README's "28 pages" proof comment under the documentation table is now one page short (not edited:
  only the row was mine). Nothing committed, staged or stashed.
