# L1: reliable on small models, 2026-09-26

Task (from the orchestrating session): constrained output on local providers (`response_format`
json_schema), seats on a local provider answer `{thought?, tool?, args?, final?}` re-rendered into the
app's `action` string, tool-call repair then retry (never fake success), thinking off for local seats
and the consolidator, the app's job timeout sized for local, heartbeat/improve gateways honour
`models.local`, hosted escalation behind the approval gate, and one live smoke at the end if load
allows. No subagents, no commits, no cloud model call. Owned: marked `// [L1]` hunks in
model-gateway/{openai-compat,index,types,local-runtime}.ts, orchestrator/seat-gateway-port.ts,
orchestrator/model-env.ts, a `// [L1] small models` block in config/sections/models.ts, NEW
model-gateway/tool-call-repair.ts, heartbeat/improve gateway construction sites.

## Log
- 23:41 start. `uptime` load 66.7 (1-min), 211 (5-min), 372 (15-min). Read AGENTS.md, CONTEXT.md,
  the rulebook, local-models research (§1, §5, §8), the landscape log (L0 reports), the plan (L1).
- 23:46 L0-1 and L0-2 landed (HEAD 75a26cb): the gateway files are committed and clean. Coordinator
  added one item: headless.ts must pass `memory.embedder` into the model env (L0-5's `[L0-5]` line in
  model-env.ts only acts when the caller passes it), with a test in apps/cli/src/runtime.

## Findings that shape the design (read from source)
- The app's seat loop (apps/web/lib/seat-agent-loop.ts) reads `{toolCall: {name, action}, summary}`;
  `name` may be an adapter or one of its scopes (every Trent adapter lists its sub-tools as scopes),
  `action` is the `<tool> <json>` string Trent's `parseAction` reads. The app's prompt carries
  `Available tools: a, b` and, for Trent tools, `action = "<tool> {...}"` usage lines: the seat port
  reads the enum from there (a decoding aid only: the app still enforces the seat's allowlist).
- Roles at the gateway: planner and critic arrive as `role: "planner"` (completion port); seats and
  the wrapper consolidator as `role: "executor"`. So "thinking off for seats and the consolidator"
  is a gateway rule: executor role + local alias -> `models.local.reasoning_effort` (default none).
- `openai-route.ts` already drops `reasoning_effort` where the provider does not document it.
- The ledger groups calls by seat/model/provider; the meter reads one `trent_usage` per port call, so
  a re-ask or an escalation needs the port to report every call it made (spend-meter hunk).
- Under a local alias `OPENAI_BASE_URL` and `OPENAI_API_KEY` point at the runtime, so hosted
  escalation can reach google, anthropic, mistral and openrouter only (their keys are separate).
- S1.1's `SoloResponseFormat` is the OpenAI wire shape; the gateway type matches it exactly.

## Plan (red first, one item at a time)
1. types.ts `GatewayStreamRequest.responseFormat`; new response-format.ts (provider table);
   openai-compat.ts body; attempts.ts + openai-route.ts pass-through (landed L0-2 files, marked).
2. seat port constrained path (schema from the prompt, re-render into the app's shape).
3. tool-call-repair.ts (think/fence/control chars, balance once, closest name, re-ask once, fail).
4. local-runtime.ts `reasoning_effort` (default none) for executor calls; index.ts precedence.
5. model-env.ts `TRENT_JOB_TIMEOUT_MS` from `models.local.job_timeout_seconds` (1800).
6. createModelGateway({local}) + heartbeat/improve sites.
7. escalation.ts: `models.escalate`, a held bound approval with the preview, then the hosted call.
8. headless.ts memory.embedder line (coordinator). 9. Live smoke at the end if load < 40.
- 23:55 `response_format` per runtime, read from the sources with curl (no model involved):
  Ollama `openai/openai.go` (ollama/ollama main; installed 0.32.9): `ResponseFormat{Type, JsonSchema{Schema}}`,
  `json_schema` -> `format = json_schema.schema`, `json_object` -> `format "json"`; and
  `ThinkingFromReasoningEffort("none")` -> `think: false`. llama.cpp `tools/server/server-common.cpp`
  :1185-1199: `json_schema` -> `response_format.json_schema.schema`; `json_object` takes `schema`.
  LM Studio structured-output page: `{"type":"json_schema","json_schema":{"name","strict","schema"}}`.
  vLLM structured_outputs page: `{"type":"json_schema","json_schema":{"name","schema"}}`. One wire
  shape serves all four: `{type:"json_schema", json_schema:{name, schema}}` (S1.1's type exactly).
- 23:54 RED item 1: response-format.test.ts 9 failed / 1 passed (bodies carry no response_format; the table is empty); a stub module first, so the red is behavioural, not a missing import.
- 00:02 item 3 RED 18/18 failed on the stub; GREEN 18/18 (tool-call-repair.ts). Item 1 GREEN 10/10.
- 00:10 item 4 RED 6 failed / 3 passed (executor on ollama got 'high'; models.local keys not bridged); GREEN 9/9 after local-runtime.ts + index.ts hunks.
- 00:14 regression: the local 'none' default made L0-2's openai-route probe /api/show before each first call (providers/local-routing/local-timeouts counted one extra request). Ollama server/routes.go ChatHandler refuses only a truthy think on a non-thinking model, so 'none' now skips the probe ([L1] hunk in openai-route.ts sendableEffort). model-gateway: 17 files / 210 tests exit 0.
- 00:22 item 2 RED 12 failed / 2 passed (no schema, no re-render, no re-ask); GREEN seat-constrained.test.ts 14/14 and seat-gateway-port.test.ts 10/10 (seat-constrained.ts new; seat-gateway-port.ts [L1] hunks).
- 00:27 meter RED 2/2 (only the last call metered; nothing metered on a thrown SeatTurnError); GREEN spend-meter.reask 2/2, spend-meter 9/9, spend-truth 2/2 (spend-meter.ts [L1] hunk: readSeatCallUsages from reply or error).
- 00:33 item 5 RED 3 failed / 1 passed; GREEN model-env.local-job 4/4, model-env 21/21, model-env.pin 7/7 (model-env.ts [L1] hunk: JOB_TIMEOUT_ENV via setIfUnset under a local alias).
- 00:38 coordinator item (headless memory.embedder): RED 2/2 (model config carried no memory; EMBEDDING_MODEL unset); GREEN 2/2 after the [L1] line in headless.ts (appEmbedder helper); headless.local-models 2/2 and headless.model 3/3 still pass.
- 00:47 config RED 3 failed / 3 passed (strict schema refused the keys); GREEN config 14 files / 75 tests after the [L1] small models block; snapshot regenerated (npx tsx scripts/dev/regen-snapshot.mjs exit 0), diff is only the L1 keys.
- 00:52 item 6 RED 2/2 (both sites built gateways without local); GREEN local-gateways 2/2 (improve-sweep.ts LoopConfig.local + both gateways; heartbeat.ts consolidate gateway).
- 00:56 RED 1 (an explicit provider:google call under ollama inherited 'none'); GREEN 10/10: localRoleEffort applies only to the alias's own route.
- 01:05 item 7 module RED 10 failed / 1 passed; GREEN escalation.test.ts 11/11 (escalation.ts: env bridge, preview, bound-approval gate, withRoleEscalation).
- 01:14 item 7 wiring RED 4 failed / 1 passed; GREEN escalation-wiring 5/5 (model-env.ts bridge line, seat-gateway-port.ts escalateFailedSeat, provider-ports.ts PortTally.executing, new port-escalation.ts, orchestrator/index.ts installPorts one line). Seat suites 10/10 + 14/14, meter 2/2, escalation 11/11.
- 01:20 cd packages/trent-core && npm run build -> exit 2 once (my seat-constrained.test.ts param type), fixed -> exit 0; npx tsc --noEmit -p apps/cli/tsconfig.json -> exit 0; docs/configuration.md lines added, docs-truth 12/12.
- 01:28 live A/B prepared as `orchestrator/seat-constrained.live.test.ts` (TRENT_TEST_LIVE=1): L0-4's
  five SMOKE_CASES, prompts and judge, through the seat port and the real gateway, constrained_output
  false then true, reasoning_effort none both; hosted keys and TRENT_ESCALATE_* removed for the run.
  Ollama 0.32.9 reachable, no model loaded. Runs only at the very end, alone, if `uptime` < 40.
- Full brief suite started in the background (load 211 / 295 / 336).

## Decisions taken (and why)
- A held planner/critic escalation is answered by the local model (the app's planner has no pause);
  a held step_failed call stays failed with the approval id in its error. The approval key carries the
  prompt's SHA-256, never its text: an approval covers that prompt to that model only.
- `reasoning_effort: none` skips L0-2's /api/show probe on Ollama (think:false is accepted by every
  model, server/routes.go), and applies only to the alias's own route (an explicit hosted call under a
  local alias does not inherit it: Gemini 3 refuses none).
- Files touched outside the brief's list, each a marked [L1] hunk and each needed: attempts.ts and
  openai-route.ts (pass-through; L0-2 had landed), spend-meter.ts (meter every call of a port call),
  provider-ports.ts (a phase getter), orchestrator/index.ts (one line: the escalating port gateway).
- 01:36 REGRESSION caught by the full suite: headless.test.ts 3 failed (a hosted profile's model dep must stay exactly {provider, model}; every profile carries the default memory.embedder). Fix: appEmbedder (moved to headless-wiring.ts) carries the block only under a local alias, where applyAppEmbeddingEnv acts. headless.test 22/22 + headless.embedder 2/2 exit 0.
- 01:42 full brief suite (first run, before the headless fix): 125 files, 3 failed / 1068 passed, exit 1; the 3 are the headless.test cases fixed at 01:36.
- 01:45 neighbours: npx vitest run packages/trent-core/src/doctor packages/trent-core/src/solo -> exit 0, 36 files / 245 tests.
- 01:52 clean rerun of the brief suite: 125 files, 1 failed / 1070 passed, exit 1; the one failure is headless.app-store.test.ts 'static graph' timing out at 60 s under load 380 (it passed in the first run); rerun alone -> exit 0, 4/4, that case 10.8 s.
- 01:56 cd packages/trent-core && npm run build -> exit 2: 10 errors in src/gateway/registry.test.ts (another lane mid-edit: platformSecretNames, webhookOnly, tokenSecret); npx tsc --noEmit -p apps/cli/tsconfig.json -> exit 2: 3 errors in packages/trent-core/src/solo/types.ts (imports ./compaction.js, ./delegate.js, ./skills.js being written by the solo lane). None in an L1 file; both were exit 0 at 01:20 with all L1 code in. node scripts/ci/repo-scan.mjs -> exit 0.
- 02:00 load window: 1-min load 31.20 (< 40) at 00:47 local; running the ONE live measurement.
- 02:05 LIVE (the one measurement): `TRENT_TEST_LIVE=1 TRENT_QUEUE_FALLBACK=disabled npx vitest run
  packages/trent-core/src/orchestrator/seat-constrained.live.test.ts` -> exit 0, 211 s. qwen3.5:9b
  (Q4_K_M, Ollama 0.32.9), reasoning_effort none both, L0-4's five cases through the seat port and the
  real gateway. Load 31 at start, 538 at the end (other lanes resumed mid-run).
  OFF (constrained_output false): 2/5. call FAIL, escaping FAIL, required FAIL (all three: "toolCall.action
  was not a <tool> <json> string"); abstain PASS; unknown-tool PASS. First token: 36.1 s (cold load),
  6.5, 7.5, 7.7, 7.3 s. Case times 36.6 / 11.6 / 24.4 / 17.4 / 30.6 s.
  ON (constrained_output true): 4/5. call PASS, abstain PASS, required PASS, unknown-tool PASS; escaping
  FAIL (the model wrapped the content in Python triple quotes: a content error, the JSON was valid).
  First token: 8.0, 8.6, 9.5, 9.8, 9.4 s. Case times 16.2 / 11.5 / 22.3 / 17.9 / 17.2 s. One model
  call per case in both runs: no re-ask was needed.
- 02:10 final static checks: `cd packages/trent-core && npm run build` -> exit 2, 5 errors, all in
  src/governance/untrusted-inbound.test.ts (another lane, in progress); `npx tsc --noEmit -p
  apps/cli/tsconfig.json` -> exit 2, 1 error in apps/cli/src/commands/groups/gateway-setup.ts (another
  lane). The earlier registry.test.ts and solo/types.ts errors had cleared. No error in an L1 file at
  any run; both commands exit 0 at 01:20 with all L1 code in.

## Open (not done in this lane)
1. Planner and critic still ask for JSON in the system message only (completion-port.ts, not an L1
   file): `{type: "json_object"}` there would grammar-constrain them on a local runtime.
2. H1's auto-review gateway (apps/cli/src/commands/groups/approvals.ts:164) is built without
   `models.local`, like heartbeat/improve were.
3. A local seat's final answer is one string: findings/recommendations arrive as [] (the brief's schema).
4. escaping stayed 0/1 on the 9B with constrained output (content wrapped in triple quotes).
5. Nothing committed, staged or stashed.
