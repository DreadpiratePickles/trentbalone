# 2026-09-12 — Tools build: file_ops + terminal for Trent's seats

Spec: `02_plan/output/tools-build-spec.md`. Requirement (verbatim): "I want it to have access to all
the tools Hermes has." Live proof recorded `Tool "read_file" is not allowed for this seat.`

## Findings from reading (before any code)
- `apps/web/lib/tools.ts:470` `adapters` is a module constant; `semantic-router.ts` builds its catalog
  from it once (`toolCatalog`), reset only by `resetSemanticRouterForTests`.
- `seat-agent-loop.ts:211` `allowedTools = toolGuidance ∩ environment.tools`; `resolveAdapter` matches
  name OR scope, so `{name:"read_file"}` resolves to the `file_ops` adapter when the seat allows it.
- `executeAdapter` passes `payload = {companyId}` only: the whole tool input is the `action` string.
- `staticHealthByAdapter` marks a real adapter `needs_credentials`; the autonomy gate only hard-blocks
  explicit block-list scopes, so the adapter still executes (comment at gate.ts:94-99).
- `LocalBackend.ts:24` spreads the whole `process.env` into children.
- Docker 29.5.3 running; `trent-sandbox:latest` image absent; `alpine:3` and `nginx:stable-alpine`
  (has curl) present. A bridge container reaches a host loopback listener via
  `host.docker.internal:host-gateway` (verified with a throwaway node server).
- `buildToolRoutingText` uses only name + scopes + manifest bits; without OPENAI_API_KEY the lexical
  TF-IDF path is used, threshold 0.42, so external adapters need their own routing text to be ranked.

## Plan (each item RED first)
0. `tools/approval-floors.ts`  1. `tools/file_ops/`  2. `tools/terminal/` + LocalBackend scrub
3. seam in apps/web (own test) + seat wiring in orchestrator  4. closing offline test + one live run

## Log
- Item 0 RED: `npx vitest run packages/trent-core/src/tools/approval-floors.test.ts` -> "Cannot find
  module './approval-floors.js'". GREEN: 7/7 after `approval-patterns.ts` (Hermes tables, POSIX
  subset, verbatim descriptions) + `approval-floors.ts` (normalise, quote-aware start marking,
  command-word projection, env unwrap, sh -c/eval payloads). Probe of 17 extra inputs matched
  Hermes semantics (quoted prose never trips the floor; `/bin/rm`, backtick, `ls | reboot` do).
- Item 1 RED: `npx vitest run packages/trent-core/src/tools/file_ops` -> "Cannot find module './index.js'".
  GREEN: 20/20 (10 local + 10 Docker alpine:3, workspace at /workspace, network none). Files:
  `tools/{types,action,spillover,sandbox}.ts`, `tools/file_ops/{paths,fuzzy,adapter,index}.ts`.
  One test edit after first run: the search assertion tripped on its own echoed pattern, not on
  a leaked secret (match count was 1). Writes are chunked base64 through the sandbox (Linux
  MAX_ARG_STRLEN), reads via `head -c 5MB`, search via `find ... | xargs -0 grep -nE`.
- LocalBackend scrub RED: "Cannot find module './env-scrub.js'"; GREEN 14/14 in `src/terminal`
  (`env-scrub.ts` = Hermes safe prefixes + secret substrings, allowlist not denylist).
- Item 2 RED: "Cannot find module './index.js'"; first GREEN run 8/9: the timeout test failed because
  busybox `timeout` signals only its direct child; a forked `sleep` kept the stdout pipe open and
  `docker exec` never returned (exit 0 after execFile's own kill). Fixed with `withGroupTimeout`
  (setsid + group kill + watchdog group kill). GREEN 9/9: inspect shows NetworkMode=none,
  CapDrop=["ALL"], no-new-privileges; `curl https://example.com` in the bridge container returns
  curl's "CONNECT tunnel failed, response 403" from EgressProxy; egress container NetworkMode=bridge.
- Seam RED: `cd apps/web && npx vitest run lib/tools.register.test.ts` -> "registerExternalAdapters is not
  a function". GREEN 4/4. Diff: tools.ts +31/-1 (createRequire loader for TRENT_TOOL_ADAPTERS_MODULE,
  `onAdapterRegistryChange`, `registerExternalAdapters` replacing by name), semantic-router.ts +5/-2
  (catalog reset listener, `routingText` in the catalog text). Full `npm test`: 2747 passed, exit 0.
- Seat wiring RED: "Cannot find module './seat-wiring.js'". GREEN 2/2. Routing finding: the lexical
  fallback embedder (no OPENAI_API_KEY) scores 0.29-0.48 for file-step phrasings against the 0.42
  threshold; when nothing clears it `executeStepWithRuntime` allows EVERY environment tool, which
  includes file_ops. The test asserts that exact semantics plus file_ops ranking first when
  anything ranks. Routing text chosen by measurement, not by guess.
- Closing test `orchestrator/orchestrator.tools.test.ts`: RED reproduced by the same run with `tools`
  omitted -> toolCalls `[{file_ops, failed, 'Tool "file_ops" is not allowed for this seat.'},
  {terminal, failed, ...}]` (the live proof's failure, one level up). GREEN 5/5: file_ops read_file
  completed with `2|  "name": "trent-fleet-monorepo"`, terminal grep completed with the same name from
  container trent-seat-isolated-* whose inspect is `none|["ALL"]`; step output carries the name.
- Docker containers are cleaned up by the adapters' `cleanup()`; verified no `trent-seat-*` left.
- Live: `TRENT_TEST_LIVE=1 npx vitest run packages/trent-core/src/orchestrator/orchestrator.tools.live.test.ts`
  4/4 on gemini-3.5-flash-lite: provider call 2 (HTTP 200) replied
  `{"toolCall":{"name":"file_ops","action":"read_file {\"path\":\"package.json\"}"}}`; the recorded
  file_ops call completed with the real name; step output carries it. Evidence JSON in the scratchpad.
- Final: `npx vitest run packages/trent-core/src/tools packages/trent-core/src/orchestrator
  packages/trent-core/src/terminal` exit 0 (17 files / 129 tests); `tsc --noEmit -p
  packages/trent-core/tsconfig.json` exit 0; `cd apps/web && npm test` exit 0 (2747 passed).
- NOTE: another session is concurrently adding `tools/{web,cron,skills,memory}` on top of this
  session's shared `types.ts` / `action.ts` / `spillover.ts` (consumers only; none of this session's
  files were modified by it). Those four suites are in the 17/129 count; this session's own are
  16 files / 124 tests. Not committed; nothing pushed.
