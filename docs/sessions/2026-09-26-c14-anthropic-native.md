# 2026-09-26 — C14: Claude gets native tools, prompt caching and abort

Agent: Opus subagent, single-writer on the files listed below. No commit, stash, checkout, reset or push.
No Anthropic key exists on this machine: every test runs against a fake Anthropic server on loopback
(node:http on 127.0.0.1), and a guard `fetch` refuses any non-loopback host, so no test can make a live call.

## Contract (council verdict `02_plan/output/hermes-council-verdict-2026-09-26.md`, C14)

- Problem: `anthropic` streams through the app's `streamAnthropicMessages` (`apps/web/lib/ai-client.ts:434-492`,
  read-only): hardcoded `https://api.anthropic.com`, `system` as a plain string, no `tools`, no `cache_control`,
  `input_tokens` only (cache fields dropped), no AbortSignal, and a non-default `temperature` on every call.
- Accept: the request carries `tools` and a `cache_control` breakpoint on the system block; a `tool_use` block
  becomes a call; the ledger prices `cache_read_input_tokens` at the cached rate; an abort cancels the request.

## Files this agent may edit

NEW `packages/trent-core/src/model-gateway/anthropic-client.ts` (+ `anthropic-client.test.ts`);
`model-gateway/index.ts`, `types.ts`, `pricing.ts` (+ test), `attempts.ts` / `retry.ts` only for pass-through;
`solo/parse.ts` (+ test); this log. Every hunk in an existing file carries `[C14]`. Not touched: `apps/web`,
`docs/*.md`, README, C11's files (runner-for-mode, config/sections/agent.ts, doctor) and C15's
(tools/memory/**, solo/prompt.ts, apps/cli/src/gateway/agent-handler.ts).

## Baseline (before any edit)

- HEAD e0834e6 (the brief said 730fe21; five commits landed since, none in model-gateway, one in
  `solo/memory-gate.ts`). Untracked `solo/turn-settings.ts` belongs to another agent: not touched.
- `npx vitest run packages/trent-core/src/model-gateway`: 18 files, 222 tests passed.
- `npx vitest run packages/trent-core/src/solo`: 20 files, 116 tests passed.

## Sources read (2026-09-26)

- Pricing: https://platform.claude.com/docs/en/about-claude/pricing (redirected from
  docs.anthropic.com/en/docs/about-claude/pricing). 5m cache write 1.25x base input, 1h write 2x, cache read
  0.1x (0.05x Opus 5.5, 0.025x Fable 5.1 / Mythos 5.1). Opus 4.5 through Opus 5 list at $5 / $25,
  Opus 5.5 $4 / $20, Sonnet 5 $2 / $10, Fable 5 and 5.1 $10 / $50; Opus 4 and 4.1 stay $15 / $75.
  Finding: the table's `claude-opus-4` prefix bills Opus 4.5-4.8 (the app's STRONG default is
  `claude-opus-4-8`) at $15 / $75, three times list.
- Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching. Up to 4 breakpoints;
  prefix order tools, system, messages; total input = cache_read + cache_creation + input_tokens.
- Effort: https://platform.claude.com/docs/en/build-with-claude/effort (supportedModels list; low, medium,
  high on every one of them). Extended thinking: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
  (`budget_tokens` >= 1,024 and < `max_tokens`; rejected with 400 on 4.7 and later).
- Opus 5.5 migration guide: https://platform.claude.com/docs/en/models/opus-5-5/migration-guide
  ("Setting temperature, top_p, or top_k to any non-default value on Claude Opus 4.7 and later models,
  including Claude Opus 5.5, returns a 400 error").
- Thinking: https://platform.claude.com/docs/en/build-with-claude/thinking ("when you return tool results,
  you must pass the thinking blocks from the assistant message back to the API, complete and unmodified").
- Hermes: `~/.hermes/hermes-agent/agent/prompt_caching.py:3-5` (four breakpoints: system and the last
  non-system messages), `agent/anthropic_adapter.py:574-603` (effort and budget mapping).

## Log

### Round 1 (steps 1 and 2 share this red): the request shape

- Test first: `anthropic-client.test.ts` "carries `tools` (input_schema per tool) and cache_control on the system
  block, the tools block and the last two user turns", through `createModelGateway` to the fake server.
- RED: `npx vitest run packages/trent-core/src/model-gateway/anthropic-client.test.ts` exit 1:
  "no `tools` on the request: expected undefined to deeply equal [ { name: 'web_search', ... } ]".
  What the guard refused (printed once, then the print was removed): `https://api.anthropic.com/v1/messages`,
  body keys `model, max_tokens, temperature, system, messages, stream`, `system` a plain string, `temperature`
  0.2. The fake server saw 0 requests: the app's streamer ignores `ANTHROPIC_BASE_URL`.
- GREEN: new `anthropic-client.ts` (body: `system` as one text block with `cache_control`, `tools` with
  `input_schema` and the breakpoint on the last tool, breakpoints on the newest two user turns; SSE text and
  usage), `index.ts` routes `anthropic` to it (`// [C14]`), `attempts.ts` passes `tools` through, `types.ts`
  gains the additive native-tool types. Same command exit 0, 1 passed. Kept minimal on purpose: no abort,
  timeout, `tool_use`, cache usage or effort yet, so each of those gets its own red below.
- Design note: tool calls ride on the existing `finish` event and frame (`toolCalls`, `providerContent`), not a
  new union member: `complete.ts` (not in this agent's set) reads every non-token, non-usage event as the
  finish, so a new event type would have broken it and every consumer written the same way.

### Round 2 (step 1): a `tool_use` block becomes a call

- Test first: "surfaces the call on the completion, with the turn as returned (thinking signature kept) for the
  next request": the fake server streams a thinking block (empty text, `signature_delta`), a text block and a
  `tool_use` whose input arrives as five-character `input_json_delta` fragments, `stop_reason: tool_use`.
- RED: exit 1, "expected undefined to deeply equal [ { id: 'toolu_01', ... } ]" (the round-1 client read text only).
- GREEN: `ContentBlocks` rebuilds each block from its deltas; the finish frame carries `toolCalls` and
  `providerContent`; `attempts.ts` copies them onto the complete outcome, `index.ts` onto the finish event, and
  `complete()` onto the completion. `stop_reason` maps `max_tokens` / `model_context_window_exceeded` to
  `length`, `end_turn` / `stop_sequence` to `stop`, anything else as sent (`tool_use`). Exit 0, 2 passed.

### Round 3 (step 1): cache usage is read, not dropped

- Test first: "reports the whole prompt as input, the cache reads as cached and the cache writes as written":
  `message_start` usage `input_tokens` 200,000, `cache_creation_input_tokens` 400,000,
  `cache_read_input_tokens` 1,000,000; output 100,000.
- RED: exit 1, `inputTokens` 200000 (expected 1600000), `cachedInputTokens` 0 (expected 1000000), no
  `cacheWriteInputTokens`.
- GREEN: `readUsage` / `usageFrame` in the client (whole prompt = the three summed, per the prompt-caching docs;
  `output_tokens_details.thinking_tokens` becomes `reasoningTokens`); `attempts.ts` and the usage event carry
  `cacheWriteInputTokens`. `complete()` is one line again: `collectWithNativeFields(stream(req), collectCompletion)`
  (in `anthropic-client.ts`, because `complete.ts` is outside this change and `index.ts` has to stay under 500).
  Exit 0, 3 passed. Whole directory: `npx vitest run packages/trent-core/src/model-gateway` exit 0, 19 files, 225 tests.

### Round 4 (step 1): an abort cancels the request

- Test first: "an abort signal cancels the request: the fake server sees the connection close". The server sends
  `message_start` and one token and holds the socket; the test aborts on the first token and waits up to 2 s
  for the server's `res` to close unended.
- First run failed on MY expectation (`['token', 'usage', 'finish:aborted']` vs `['token', 'finish:aborted']`):
  the gateway meters a partial answer with an estimated usage row before the aborted finish on every route.
  The assertion was corrected to that existing behaviour; no code changed.
- RED: exit 1, "expected 'still open' to be 'closed'": 2 s after the abort the socket was still open.
- GREEN: the client links the run's signal to its own AbortController, gives it to `fetch` (which also aborts
  the body read), and its `finally` aborts when the consumer stopped early. Exit 0, 4 passed.

### Round 5 (step 1): the 60 s default becomes configurable

- Tests first: config `anthropicTimeoutMs: 150` ends a request whose headers never come, names the setting and
  closes the socket; `TRENT_ANTHROPIC_TIMEOUT_MS=150` does the same for a gateway built without the field;
  `resolveAnthropicTimeoutMs` resolves config, then env, then 60,000 (a non-positive or non-numeric value ignored).
- RED: exit 1, 3 failed: "expected 'no timeout fired within 1.5 s' to match /TimeoutError: anthropic sent no
  respo.../" (twice) and "expected undefined to be 60000" (no such export).
- GREEN: `ANTHROPIC_HEADERS_TIMEOUT_MS` 60,000 and `ANTHROPIC_TIMEOUT_ENV`; a headers deadline aborts the
  controller and throws a `TimeoutError` ("anthropic sent no response headers within 150 ms
  (TRENT_ANTHROPIC_TIMEOUT_MS)"), which `retry.ts` already classifies as a timeout (retried once). The stream
  after the headers has no clock, as on every hosted route; the AbortSignal ends it. `index.ts` passes
  `config.anthropicTimeoutMs`. First green run failed on a TEST bug (`await silentServer()` adopted the
  returned promise and waited out the 1.5 s window before sending); instrumenting showed the client correct
  (timeout at 182 ms, server socket closed 179 ms after the request). Helper fixed to return `{ closed }`.
  Re-proved the red against the fixed test by pinning the timeout to the default in the source (exit 1, both
  "no timeout fired within 1.5 s"), then restored the file (`cmp` identical). Exit 0, 7 passed.

### Round 6 (step 1): reasoning_effort where documented, temperature only where accepted

- Found while reading: a non-default `temperature` "returns a 400 error" on Opus 4.7 and later (Opus 5.5
  migration guide) and on Sonnet 5 (its migration guide). The gateway always sends one (default 0.2), and the
  app's streamer sent it too, so every call to the app's own STRONG default (`claude-opus-4-8`) would have been
  refused. Manual `thinking.type: enabled` is rejected on 4.7 and later; `output_config.effort` is the control there.
- Test first (table, 10 cases through the gateway): Opus 5.5 low -> `output_config.effort: low`, no thinking, no
  temperature; minimal -> low; Sonnet 5 high; Sonnet 4.6 keeps temperature (with and without effort); Haiku 4.5
  high -> `thinking {enabled, 16000}`, `max_tokens` 2000 + 16000, no temperature; low -> 1,024; Opus 4.5 medium ->
  effort AND budget 8,000 ("set both"); `none` on Opus 5.5 and any effort on an unlisted id -> nothing sent and
  `model_gateway.reasoning_effort_not_sent` logged.
- RED: exit 1, 9 failed (the Sonnet 4.6 no-effort case already matched): e.g. "temperature must not be sent to
  claude-opus-5-5: expected {...} to not have property \"temperature\"".
- GREEN: `MODEL_TRAITS` (longest id prefix: effort / budget / sampling, each row cited in the file), `modelFields`;
  the anthropic branch in `index.ts` now runs before the app-streamer effort line and passes `onEffortDropped`.
  Exit 0, 17 passed.

### Round 7 (step 1): a native tool loop goes back as tool_use and tool_result blocks

- Tests first: (a) an assistant turn with `providerContent` is replayed verbatim (thinking signature included) and
  the result message (`toolCallId`) becomes a `tool_result` carrying the breakpoint; (b) without
  `providerContent`, `tool_use` blocks are built (no empty text block), two consecutive results merge into one
  user turn (`is_error: true` on the failed one), and the breakpoints land on that turn and the next user text.
- RED: exit 1, 2 failed ("expected [ { role: 'user', ... } ...] to deeply equal ...": the round-1 mapping sent
  the assistant turn as plain text and each result as a separate text turn).
- GREEN: `turnOf`, `withBreakpoint`, `conversation` rewritten. Exit 0, 19 passed.

### Round 8 (step 2): a route without native tools reads the same conversation as text

- Test first: the same native conversation sent on `google` (through the gateway's `fetchImpl` seam, base URL
  127.0.0.1:9) must reach the wire as `{role, content}` only, the call rendered into the assistant text as
  `[called web_search {"query":"York"}]`, and no `tools`.
- RED: exit 1, the body carried `providerContent` and `toolCallId` (`buildCompatChatBody` sends messages
  verbatim; a strict OpenAI-compatible server refuses unknown message fields).
- GREEN: `textOnlyMessages` (in the client, beside the native mapping it mirrors); `index.ts`'s default stream
  function hands every route but `anthropic` the projection (one line). Exit 0, 20 passed; the whole directory
  exit 0, 19 files, 242 tests.

### Round 9 (step 1): failures are the retry policy's to classify

- Test first: attempt 1 answers HTTP 429 (`retry-after: 0`), attempt 2 a 200 stream carrying
  `{"type":"error","error":{"type":"overloaded_error"}}`, attempt 3 the answer; retry attempts 3, sleep stubbed.
- RED: exit 1, "expected [...] to have a length of 3 but got 2": the in-stream error ended attempt 2 as a quiet
  empty success.
- GREEN: `ERROR_STATUS` from https://platform.claude.com/docs/en/api/errors (400, 401, 402, 403, 404, 409, 413,
  429, 500, 504, 529); an `error` event throws the matching `ProviderHttpError`; an unreadable event throws a
  message naming its length only. Retry log statuses `[429, 529]`. Exit 0, 21 passed.
- Size: the client reached 525 lines; compacted to 495 with no behaviour change (the route reuses
  `AnthropicInput`, shorter doc comments). Exit 0, 21 passed. `cd packages/trent-core && npm run build` exit 0.

### Step 3: pricing — requirement change, recorded before any test is touched

- Changed requirement (C14 "the ledger prices `cache_read_input_tokens` at the cached rate"): Anthropic rows carry
  Anthropic's published read ratio (0.1; 0.05 Opus 5.5; 0.025 Fable 5.1 / Mythos 5.1) instead of the 0.25
  default, and a 5-minute cache write is priced at 1.25x base input. Two existing assertions in
  `pricing.test.ts` pinned the OLD behaviour by using `claude-sonnet-4-6` as the example of "a row with no ratio of
  its own" (`:73` ratio undefined, `:85-86` 75 cents for 1M cached). Their intent (the default ratio for a row that
  states none, and the tier fallback) is kept by re-pointing them at `mistral-large-latest` (a row with no ratio,
  $2.00 / 1M, so 1M cached = 50 cents); the Anthropic figures move to the new C14 tests. Nothing is deleted or skipped.
- Second correction, same source and same file: the `claude-opus-4` prefix bills Opus 4.5 through 4.8 at
  $15 / $75; the pricing page lists $5 / $25 (Opus 4 and 4.1 stay $15 / $75). Without it the cached rate of the
  app's STRONG default (`claude-opus-4-8`) would be three times list too.
- Known residual, outside this agent's files: the run ledger re-prices every call itself
  (`orchestrator/run-hooks.ts:183` `priceCallMicroCents({ inputTokens, outputTokens, cachedInputTokens })`) and
  `RunModelCall` has no cache-write field, so the LEDGER prices reads correctly after this step but prices writes at
  the base input rate (0.25x base low on written tokens) until `run-hooks.ts`, `solo/turn.ts` `charge()` and
  `orchestrator/spend-meter.ts` `modelCall()` pass `cacheWriteInputTokens`. The gateway's own `costCents` is right.
- Tests first (`pricing.test.ts`, new describe "[C14] Anthropic's cache write and read rates, and its current list
  prices"): 1.6M prompt on claude-sonnet-4-6 (1M read, 400k written) + 100k out = 390 cents, and 390,000,000
  micro-cents; every Anthropic row carries its read ratio and the 1.25 write ratio; Opus 4.5 to 5 at $5 / $25
  (3,000 cents for 1M in + 1M out), Opus 4.1 stays 9,000, Opus 5.5 2,400, Sonnet 5 1,200, Fable 5.1 6,000,
  Haiku 4.5 600; the tier fallback bills a write as 1.25 full-rate tokens (rounded up) and reads plus writes are
  clamped to the prompt; the RUN LEDGER (`run-hooks.ts` `recordRunModelCall`, unedited) charges 1M Claude cache
  reads 30 cents.
- RED: `npx vitest run packages/trent-core/src/model-gateway/pricing.test.ts` exit 1, 5 failed: "expected {
  costCents: 405 } to match { costCents: 390 }", ratio missing, "claude-opus-4-5-20251101: expected 9000 to be
  3000", "expected [ 925 ] to deeply equal [ 1126 ]", ledger "expected 75 to be 30". The two re-pointed
  assertions (mistral, 50 cents) passed, as their intent is unchanged.
- GREEN: `anthropic-list-2026-09` rows via `claude(input, output, readRatio)`, `cacheWriteInputRatio`,
  `DEFAULT_CACHE_WRITE_RATIO` 1.25, `cacheWriteInputTokens` on `PriceCallInput` (clamped to what the reads leave),
  `inputMicroOf` shared by `centsFrom` / `microCentsFrom`, `overrideRowFor` carries both ratios. Exit 0, 34 passed.
- Gateway: test first in `anthropic-client.test.ts` "prices the reads at the cached rate and the writes at the
  write rate: 390 cents". RED exit 1, `costCents` 360 (writes at base: `index.ts` did not hand them to
  `priceCall`). GREEN: one `// [C14]` edit to the `priceCall` call. Exit 0, 22 passed.
- Regression: `npx vitest run packages/trent-core/src/model-gateway` exit 0 (19 files, 249 tests);
  `.../orchestrator` exit 0 (30 files, 219); `.../governance` exit 0 (17, 216);
  `apps/cli/src/repl/__tests__/budget.test.ts` exit 0; `apps/cli/src/commands/__tests__/budget.test.ts` exit 0.

### Step 4: solo/parse.ts accepts a native tool call alongside the text protocol

- Tests first (`solo/parse.test.ts`, "[C14] a native tool call is the same internal call the text protocol
  produces"): a native `read_file` call with an empty reply becomes exactly the actions the `<tool_call>` body
  produces, carries `callId`, and the history keeps it rendered in the taught format; narration without
  `<think>`, a text block alongside runs, a call written both ways runs once; an unknown native tool is
  malformed with the text protocol's words; with no native calls (absent or `[]`) the envelope and the empty-reply
  rule are exactly as before (local models keep the text protocol and constrained output).
- RED: `npx vitest run packages/trent-core/src/solo/parse.test.ts` exit 1, 3 failed: "expected actions, got
  {"kind":"malformed","error":"the reply was empty; ..."}", "expected [ [ 'read_file', undefined ] ] to deeply
  equal [ [ 'write_file', 'toolu_02' ], ... ]", "expected 'the reply was empty; ...' to contain 'Unknown tool
  \"email_send\"'". The local-protocol guard passed before and after.
- GREEN: `ParseOptions.toolCalls`, `SoloAction.callId`, `withNativeCalls`, and the block scan moved unchanged into
  `scanBlocks`. Exit 0, 14 passed. First `npm run build` failed (exit 2, TS2677 on a type predicate I simplified);
  fixed by annotating `native` as `(SoloAction | string)[]`, build exit 0.

## Verification (final)

- `npx vitest run packages/trent-core/src/model-gateway` exit 0: 19 files, 249 tests (baseline 18 / 222).
- `npx vitest run packages/trent-core/src/solo` exit 0: 22 files, 133 tests (baseline 20 / 116; other agents added
  2 files meanwhile).
- `npx vitest run packages/trent-core/src/model-gateway/anthropic-client.test.ts` exit 0, 22 tests.
- `cd packages/trent-core && npm run build` exit 0. `npx tsc --noEmit -p apps/cli/tsconfig.json` exit 0.
- `node scripts/ci/repo-scan.mjs` exit 0 (3 checks PASS, 0 violations).
- Every hunk of every edited existing file carries `// [C14]` (checked per hunk with `git diff -U3`): index 9,
  types 10, attempts 7, pricing 11, pricing.test 4, solo/parse 5, solo/parse.test 1; 0 unmarked.
- Line counts: anthropic-client.ts 495, its test 458, index.ts 492, types.ts 304, attempts.ts 215, pricing.ts 383,
  pricing.test.ts 420, solo/parse.ts 255, solo/parse.test.ts 118.
- No live call was made or attempted: every Anthropic request went to 127.0.0.1, and the guard `fetch` refuses any
  other host.

## Residuals, stated

1. The solo turn does not REQUEST native tools yet. `solo/runner.ts:122-128` builds the request without `tools`, and
   `solo/turn.ts:305` calls `parseReply` without `completion.toolCalls`. Both files are other agents' (C11 is in
   turn.ts). The gateway, the client and the parser are ready; the wiring is two lines plus a tool-definition list
   built from the toolsets' `*_TOOL_SCHEMAS` for an `anthropic` route only.
2. The run ledger bills Anthropic cache WRITES at the base input rate (reads are right): `run-hooks.ts:183` re-prices
   without a write count. Needs `RunModelCall.cacheWriteInputTokens` and the two callers (`solo/turn.ts` `charge`,
   `orchestrator/spend-meter.ts` `modelCall`).
3. The gateway's default `maxTokens` is 4,096. Opus 5.5 and Fable 5.1 always think, and thinking counts toward
   `max_tokens`: a live session should watch for `finishReason: "length"`.
4. Only the 5-minute TTL is sent; a 1-hour option (2x write) is not configurable.
5. Opus 5.5 / Fable 5.1 bind a replayed thinking block to the unchanged prefix before it; whether moving the
   user-turn breakpoints between requests counts as a change is not documented and can only be seen live.

## What a live 5-turn Claude session must show (no key on this machine)

Key in the environment only, never printed. After residual 1 is wired: `provider: anthropic`, a model whose minimum
cacheable prefix the solo prompt clears (Sonnet 4.6 / Opus 4.8 / Sonnet 5: 1,024 tokens; Opus 5.5: 512; Opus 4.5,
4.6 and Haiku 4.5: 4,096), five turns, at least two with a tool call:
- every response HTTP 200 (no 400 on temperature, thinking or tools);
- turn 1 usage has `cacheWriteInputTokens > 0`; turns 2-5 have `cachedInputTokens > 0` on the usage row and in
  `trent usage --json`;
- each `tool_use` ran as the same `<tool> <json>` action (idempotency key and approval row unchanged);
- cents saved per turn = read tokens x 0.9 x input rate - write tokens x 0.25 x input rate (not printed by any
  surface yet; compute from the ledger rows);
- Ctrl+C mid-answer ends the run at once and the next turn works;
- no `finishReason: "length"` on an ordinary turn.

## Doc text handed to the lead (not applied: docs/*.md are not this agent's)

`docs/configuration.md`
- "Providers", replace "`anthropic`, `mistral` and `openrouter` use the app's streamers." with: "`anthropic`
  streams through the gateway's own Messages API client (`model-gateway/anthropic-client.ts`): the request's
  `tools` as native schemas, prompt-cache breakpoints on the tools block, the system block and the newest two user
  turns, cache read and write counts, cancellation that closes the socket, and a 60 s response-headers timeout
  (`TRENT_ANTHROPIC_TIMEOUT_MS`). `mistral` and `openrouter` use the app's streamers."
- Providers table, `anthropic` row, Endpoint column: "Anthropic (`ANTHROPIC_BASE_URL`)".
- "Pinned models and reasoning effort", after the Ollama sentence: "On `anthropic` the value is sent as
  `output_config.effort` to the models Anthropic lists for it (Opus 4.5 and later, Sonnet 4.6, Sonnet 5, Fable,
  Mythos; `minimal` goes as `low`), and as a manual thinking budget (1,024 for `minimal` and `low`, 8,000 for
  `medium`, 16,000 for `high`, added to `max_tokens`) to models that only have manual thinking (Haiku 4.5, Sonnet
  4.5 and earlier; Opus 4.5 gets both). `none` is honoured by omission on a manual-thinking model and dropped
  elsewhere. `temperature` is sent only to models that accept a non-default value: Opus 4.7 and later and Sonnet 5
  answer it with a 400."
- "Retry and fallback", after the first paragraph: "An `error` event inside an Anthropic stream is classified by
  the HTTP status its type stands for (`overloaded_error` 529, `api_error` 500, `rate_limit_error` 429), so it is
  retried or not exactly like the response it replaced."
- "Model pricing", after the cached-token paragraph: "Anthropic reports cache writes separately. The usage row's
  `cacheWriteInputTokens` bill at 1.25x the input rate (the 5-minute write, the only one Trent sends) and cache
  reads at the model's read ratio: 0.1, or 0.05 on Opus 5.5 and 0.025 on Fable 5.1 and Mythos 5.1
  (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-09-26). The spend ledger re-prices every
  call from its tokens and does not yet receive the write count, so it bills writes at the input rate for now."

`docs/solo.md`
- New section after "Constrained output": "## Native tools on Claude. On `anthropic` a request can carry the tools
  as native schemas, and Claude answers with `tool_use` blocks. `solo/parse.ts` turns each into the same `<tool>
  <json>` action a `<tool_call>` body produces, so the idempotency key and the approval row are unchanged; a
  `<tool_call>` block in the same reply still runs, and a call written both ways runs once. Local models keep the
  text protocol and constrained output. The solo turn does not send `tools` yet (see Limits)."
- "Spend and audit", add: "On Claude, the tools, the system prompt and the conversation up to the previous turn are
  cached: from the second turn the usage row shows `cachedInputTokens`, billed at a tenth of the input rate."
- "Limits", add: "Claude's native tool calls are parsed but not yet requested: the solo runner does not put `tools`
  on the request or hand `toolCalls` to the parser, so Claude follows the `<tool_call>` protocol in the prompt
  like any hosted model." and "The ledger bills Anthropic cache writes at the input rate until the run meter
  receives the write count."
