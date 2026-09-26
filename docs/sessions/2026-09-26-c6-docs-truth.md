# 2026-09-26 — C6: the docs tell the truth, and a test keeps them honest

Council item C6 (`02_plan/output/hermes-council-verdict-2026-09-26.md`, Tier 1). No commit, stash,
checkout, reset or push. No subagents (the brief says so). Every hunk in an existing source file carries
`// [C6]`; docs carry no markers.

Owned (the brief's list, nothing else): `apps/cli/src/commands/__tests__/docs-truth.test.ts` (and a
second test file beside it if the first would pass 500 lines), README.md, AGENTS.md, CONTRIBUTING.md,
`docs/*.md`, `apps/cli/src/commands/groups/fleet.ts:25`, `apps/cli/src/commands/groups/improve.ts:6`
(`// [C6]`), and this log. Not touched: runner-for-mode.ts, config/sections/agent.ts, doctor (C11);
tools/memory/**, solo/prompt.ts, gateway/agent-handler.ts (C15); model-gateway/**, solo/parse.ts (C14).
`docs/local-models.md` and `docs/solo.md` are C11's: only wrong command names or stale rows may change there.

## Read first
AGENTS.md; the rulebook's Universal Coding Rules and Phase 4; C6 and section 2 of the council verdict;
stage1-C-truth.md (claims table), stage2-ranker-2.md and stage2-ranker-3.md; the docs-truth test;
`apps/cli/src/commands/registry.ts` and `index.ts` (COMMAND_SPECS).

HEAD at start: 7f58c25; e0834e6 (ci(live)) landed by another agent while this ran. README line numbers
have shifted by +1 against the council's citations (:171 iron-proxy is now :172, :175 adapters :176,
:183 "(no client)" :184, :28 exit 1 :29).

## Baseline (before any edit)
`npx vitest run apps/cli/src/commands/__tests__/docs-truth.test.ts` -> exit 0, 12 tests passed (4 pages).

## The test (what changed, and why two files)
- NEW `apps/cli/src/commands/__tests__/docs-truth-pages.test.ts`. The old file was 375 lines; adding
  every page, flags and paths would pass 500, so the all-pages checks live beside it. PAGES is read off
  the disk (`docs/*.md`, 31 pages) plus README.md, AGENTS.md, CONTRIBUTING.md: 34 pages.
  - every `trent <cmd>` / `trent <cmd> <sub>` (and `npm run [--silent] cli[:bun] --`) resolves in
    COMMAND_SPECS; deeper levels are descended (`trent cron queue edit`); a group that also takes an
    argument (`connect [provider]`) treats a non-subcommand word as that argument (read from the spec's
    name, not listed).
  - every `--flag` after a command is in that spec's `options` or GLOBAL_LONG_FLAGS (or `--help`);
    quoted arguments are values (`--gate "typecheck=npx tsc --noEmit"` names no `--noEmit`); a flag
    after a bare `trent` must be declared on the root program (`buildProgram().options`).
  - every backticked path under `packages/`, `apps/cli/`, `scripts/` exists (`:12-40` suffix dropped,
    `{a,b}` expanded, a `*` checked up to its directory).
  - ABSENCE_SECTIONS lists the eleven "Not yet implemented" sections by page and heading; two tests
    hold the list to the pages ("lists only headings that exist", "lists every absence heading"), which
    also bounds the old file's pattern skip. OTHER_TOOL_FENCES is empty: no fence needed it (the
    extraction dump showed no false positive from another tool's block).
- `docs-truth.test.ts`: the three command-resolution tests MOVED to the new file (which covers the same
  four pages and 30 more); the README count test stays. NEW: "resolves every dotted key the page names
  in prose" walks each `a.b.c` code span in docs/configuration.md down TrentConfigSchema at any depth
  (records and arrays open to user names; ZodEffects and unions peeled), with NOT_CONFIG_KEYS listing
  the 8 dotted names that are spans, events or response fields; and a guard that a misspelt key fails.
- Extraction sanity (a temporary dump, since removed): 643 invocations on 33 pages (the rulebook names
  none), 641 resolved, 218 flags checked, `gateway pair|pairings|revoke` resolve (730fe21).

## RED
`npx vitest run apps/cli/src/commands/__tests__/docs-truth-pages.test.ts` -> exit 1, 3 failed | 6 passed:
- resolves every documented command: `docs/checkpoints.md:114: trent checkpoints`
- names only flags the command accepts: `docs/configuration.md:1047: trent improve --live`
- resolves every repository path: `docs/desktop.md:26: scripts/prepare-resources.mjs`
(First run also flagged `trent goal create --no` and 14 `trent connect <provider>` rows: both were
extractor noise, a flag inside a quoted value and a group that takes an argument; fixed in the test.)
`docs-truth.test.ts` with the dotted-key check -> exit 0, 11 passed: every dotted key in
docs/configuration.md already resolves, so that check is green from the start (no red to record).
`trent gateway pair` passes, as the brief expected.

## GREEN for the three test-caught rows
- `docs/checkpoints.md:114` named `trent checkpoints list|rollback`. Evidence: `trent checkpoints list`
  (throwaway HOME/TRENT_HOME, `npx tsx apps/cli/src/index.ts checkpoints list --no-color`) -> exit 2,
  "unknown command 'checkpoints'"; no spec in `apps/cli/src/commands` names checkpoints; the REPL
  registers `/checkpoints` and `/rollback` (`apps/cli/src/repl/commands.ts:365-366`,
  `repl/checkpoint-commands.ts:44,74`). Now: "There is no `checkpoints` CLI command; listing and
  undoing turns is `/checkpoints` and `/rollback` in the REPL."
- `docs/configuration.md:1047` `trent improve --live`: `--live` is on `sweep` (`improve.ts:155`) and
  `promote` (`:189`), not the group; the gateways that get `models.local` are the sweep's
  (`improve-sweep.ts:92-93,201`). Now `trent improve sweep --live`.
- `docs/desktop.md:26` `scripts/prepare-resources.mjs`: the file is `apps/desktop/scripts/prepare-resources.mjs`
  (`find`), wired as `"beforeBuildCommand": "node scripts/prepare-resources.mjs"` in
  `apps/desktop/src-tauri/tauri.conf.json:8`. Now the repo path.
`npx vitest run apps/cli/src/commands/__tests__/docs-truth-pages.test.ts` -> exit 0, 9 passed.
(The docs-corpus fixture embeds page text with its own sha256; it checks the fixture against itself,
`improve/docs-corpus.ts:119-127`, not against live pages, so doc edits cannot break it.)

## Evidence for the council's rows (gathered before editing each)
- README:29 (council: "says exit 1; run.ts:170 returns 5"). Measured: keyless, throwaway HOME and
  TRENT_HOME, `env -i PATH=... npx tsx apps/cli/src/index.ts run "Write a one-line tagline for a bakery" --no-color`
  -> exit 1, "$0.00", "Run failed: every model call failed: No model provider API keys are configured";
  with `--json` -> exit 1, `{"status":"failed",...}` and no `reason` field. Exit 5 (`EXIT.PROVIDER`,
  `errors/TrentError.ts:39`) is for a run whose calls a provider REFUSED (`reason: model_calls_failed`,
  `run.ts:170`; `run-verdict.test.ts:78-112`, a 429). So ":28 exits 1" HOLDS for a keyless run; the
  council's reading applies to a provider refusal. README keeps "exits 1" and now also names 5; the
  Commands block's exit list lacked 5 although `trent run --help` (`run.ts:385`) lists it.
- README:172 iron-proxy: `npx vitest run packages/trent-core/src/egress/EgressProxy.host-binding.test.ts`
  -> exit 0, 6 passed (9fee7d2: "the provider host receives the key; another allowlisted host receives
  the request with no credential").
- README:176 adapters. Counted: `ls packages/trent-core/src/gateway/platforms/` -> 12 adapters, each with
  a `*.wire.test.ts` against a fake server of its platform; run one file at a time, all exit 0 (discord 4,
  email 12, homeassistant 3, line 8, matrix 7, mattermost 7, ntfy 6, signal 3, slack 5, teams 3,
  telegram 6, whatsapp 4 tests); `gateway/registry.test.ts` exit 0, 29. End-to-end through
  `trent gateway start`: `grep -rln '"gateway", "start"'` finds 4 test files; in gateway-start,
  heartbeat and profile-locks `startAllConfigured` is mocked and no message crosses an adapter; the
  one that drives an adapter over HTTP is `gateway-webhooks.test.ts` "LINE up and no route ...
  /webhooks/line reaches the adapter" (signed POST 200, forged 401) -> exit 0, 6 passed. So the number is
  1 (LINE). Telegram's inbound and pairing run through the real GatewayManager in
  `gateway-pair.test.ts` (exit 0, 5 passed), not through the command. Eight `*.live.test.ts` exist and
  have never run in CI (council agreed row 5).
- AGENTS.md:40 gate: `cd apps/web && npm test` (background, load 63-77) -> exit 1: "Test Files 2 failed
  | 513 passed | 13 skipped (528)", "Tests 3 failed | 2826 passed | 125 skipped (2955)", 260 s; all three
  were 10 s timeouts ("Hook timed out in 10000ms") in `lib/workbench-intent-policy.test.ts` and
  `lib/workbench-starter-template.test.ts`. Rerun alone (`npx vitest run --pool=forks
  --poolOptions.forks.singleFork=true <file>` in apps/web): exit 0, 20 passed; exit 0, 4 passed.
- AGENTS.md:41 "root vitest run ... two phantom failures": `npx vitest list --filesOnly` -> exit 0,
  520 files, 0 under `apps/web/`, no gbrain or railway file; `vitest.config.ts` `include` is an
  allow-list of `packages/trent-core` and `apps/cli`. CI's core job runs
  `npx vitest run packages/trent-core apps/cli` (`.github/workflows/ci.yml:240`). Stale. (ci.yml:118-122
  and vitest.config.ts:25-26 repeat "505 files / 2743 tests"; neither file is mine to edit.)
- AGENTS.md defects, the four fixes, each test run one file at a time: B1
  `packages/trent-core/src/egress/EgressProxy.host-binding.test.ts` exit 0 (6) and
  `egress/CredentialBroker.test.ts` exit 0 (27); B2 `apps/cli/src/runtime/headless.memory-gate.test.ts`
  exit 0 (2); B3 `apps/cli/src/commands/__tests__/gateway-webhooks.test.ts` exit 0 (6); pairing
  `apps/cli/src/commands/__tests__/gateway-pair.test.ts` exit 0 (5). Test files per commit from
  `git show --stat` of 9fee7d2, 0ee887c, d364755, 730fe21.
- docs/configuration.md:1242-1249 "Voice transcription" (absence list): wrong now. `gateway.voice_notes`
  is in the schema (`config/sections/gateway.ts:137`); `gateway/voice-notes.ts` transcribes a paired
  sender's note on nine adapters; `voice/index.ts:1-11` runs the media engines and throws only with no
  engine. Still true: no top-level `voice` key (schema keys printed via tsx), no `/voice`
  (`repl/commands.ts:418` answers "Unknown command: /<name>"), the schema is `.passthrough()`
  (`config/schema.ts:231`). `voice/voice.test.ts` exit 0 (2); `gateway/voice-notes.test.ts` exit 0
  (12 passed, 1 skipped).
- docs/desktop.md:67 "`trent web --start` ... reports readiness only": wrong. `--start` "Start the
  server rather than reporting readiness" (`servers.ts:346`); `web.test.ts` exit 0 (10) incl. "spawns the
  standalone entry with the desktop's env contract".
- docs/mcp.md:75-77 vs :189-190: :77 says run `trent mcp test <name>` once reachable; :189-190 says
  `add` and `test` cannot connect to an http server from the CLI (no egress proxy). The code agrees with
  :189 (`mcp.test.ts:246-247` asserts the reason contains "egress proxy"; `mcp.test.ts` exit 0, 16), so
  an http server's install scan never runs from the CLI (ranker 2 row 27).
- docs/getting-started.md:457 "the repository is private": `gh api repos/DreadpiratePickles/trentbalone`
  -> `"private":false,"visibility":"public","has_pages":false`. Installer
  `curl -w '%{http_code}' https://agent.let-trent.uk/install.sh` -> 404; `git ls-remote --tags origin`
  -> 0 lines; `gh release list` -> empty. Only "private" is wrong.
- fleet.ts:25 "164-specialist": `trent fleet list --json` (throwaway home) -> exit 0, 173 agents: the 9
  seats with toolsCount 2 each, 164 specialists with toolsCount 0 (none has a tool).
- improve.ts:6 "the only way an artifact reaches an agent": `readSeatPrompt` is reached only through
  `defaultSeatPromptProvider` (`improve/seat-prompt.ts:37-41`), used only by `improve/sweep.ts:41,51`;
  no orchestrator, solo or runtime file reads it (`grep -rn`). A promoted seat prompt reaches the next
  sweep, not a live seat.
- README:234 "A reranker is decided, not landed": 0f740e6 built it; `recallFromBrain(` is called only from
  `fleet-memory/retrieval-eval.ts:83` and `improve/retrieval-metrics.ts:73`; docs/brain.md:296 already
  says "Not wired yet".
- README:179-180 Hermes counts (section 2 row 15): in `~/.hermes/hermes-agent` at 49eb7b5dba (0.21.3),
  `git ls-files plugin-catalog/*.yaml | wc -l` -> 216 (ranker 3 said 215; 216 is what the command
  prints); `find skills -name SKILL.md` -> 58, `find optional-skills -name SKILL.md` -> 150.
- README:306 test counts: `gh run list --branch feature/trent-fleet-v2 --workflow ci.yml` -> last green
  36226144639 on 7f58c25 (2026-09-26T07:13Z); job logs: core 108360615545 "Test Files 512 passed (512)",
  "Tests 4882 passed | 23 skipped (4905)"; web 108360615653 "515 passed | 13 skipped (528)",
  "2829 passed | 125 skipped (2955)"; docker 108360615825 "38 passed (38)", "296 passed (296)"; the four
  binaries/RUN jobs and all-checks-pass success. (The next run, 36226196095 on e0834e6, failed: not
  this item's commit.)
- `cd apps/web && npm test` rerun (background, load ~72) -> exit 0: "Test Files 515 passed | 13 skipped
  (528)", "Tests 2829 passed | 125 skipped (2955)", 270 s. This is the count AGENTS.md now states.
- README comparison rows, one test per row, each run on its own (`npx vitest run <file>` unless noted),
  all exit 0: pages-release-gate (`node --test`, 10), improve/store (real Bun spawned, 2),
  store-durability 2, seat-capabilities 9, FleetManager 16, run 21, spend-ledger 14, bound-approvals
  10, autonomy 19, auto-review-policy 23, EgressProxy.host-binding 6, checkpoints/rollback 8, improve
  (cli) 6, audit/export 13, audit (cli) 10, gateway-webhooks 6, gateway-pair 5, service/units 12,
  voice-notes 12+1 skipped, plugins 7, mcp 16, skill-store 9, pack-skills 10, ingest/extract 12,
  apps/desktop `npx vitest run tests/capabilities.test.ts` 14, tools/a2a/a2a 8, run-verdict 5.
  store-durability and service-durability only SIMULATE Bun (`process.versions.bun`), so the Language
  row names improve/store.test.ts first, which spawns the real binary.
- "Where Trent is ahead" items, tests named in its proof comment, each exit 0: brain 10, judge-model 16,
  suite-split 6, pass-k 6, post-promote 4, business stripe 9 / square 5 / calendar 7 / sms 4,
  social 9, media 10, export-claude 5, export-codex 7, export-hermes 9, import-foreign 8,
  policy-rules 14, docs-corpus 17.
- `docs-truth-pages.test.ts` gained "the README names a test for every comparison row" (rows read from
  the table, tests from the list under it). Red by mutation: with the Voice entry removed -> exit 1,
  `+ "Voice"`; restored -> exit 0, 11 passed.

## Corrections made (one line each; evidence above; README line numbers are the edited file's)
- docs/checkpoints.md:114: no `trent checkpoints`; REPL `/checkpoints` and `/rollback`.
- docs/configuration.md:1047: `trent improve --live` -> `trent improve sweep --live`.
- docs/desktop.md:26: `scripts/prepare-resources.mjs` -> `apps/desktop/scripts/prepare-resources.mjs`.
- docs/desktop.md:67: dropped the absence bullet "`trent web --start` ... reports readiness only";
  one sentence under "Installing from the CLI" says `web --start` runs the same standalone tree.
- docs/configuration.md voice bullet: absence narrowed to the `voice` key and `/voice`; transcription
  via `gateway.voice_notes` and `voice/` stated.
- docs/mcp.md:75-77: an http server is always `scanRan: false` from the CLI and `test` cannot reach
  it; `mcp test` advice kept for a stdio server whose command was missing. Now agrees with :189-190.
- docs/getting-started.md:457: "and the repository is private" removed (it is public).
- README:29-30 and the Commands block: exit 5 (a provider refused the calls) named; "exits 1" kept.
- README:173 credential isolation: host-bound, cites EgressProxy.host-binding.test.ts; Hermes cell
  "iron-proxy, which binds each key to its own hosts".
- README:176 audit: "needs Bun".
- README:177 messaging: 12 adapters on local fakes; 1 (LINE) end to end through `gateway start`;
  `gateway pair`. How counted: in the proof comment.
- README:180-181 Hermes counts: catalog 216 (v0.21.3), skills 58 + 150.
- README:185 proof comment: "(no client)" -> server plus client tools; host binding, LINE count, Bun.
- README: visible re-run list under the table (17 rows); ahead-list proof names its tests.
- README:258: the reranker is built and not wired (not "decided, not landed").
- README:275 proof "(server files only)" -> server plus client tools.
- README:327 proof "28 pages" -> 31.
- README Tests: run 36226144639 on 7f58c25, 4882/23 (512), 2829/125 (528), 296 (38), live job skipped.
- AGENTS.md:40-41: gate counts measured; the root-run claim replaced by what the config and CI do.
- AGENTS.md defect 10: B1, B2, B3 and pairing, "Fixed, re-verified" with their tests (5 files, 46).
- AGENTS.md marker grep: 24 -> 28 lines; `tools/index.ts:77` -> `:104`; the two importers named.
- apps/cli/src/commands/groups/fleet.ts:25 (`// [C6]`): help text names the nine seats that run.
- apps/cli/src/commands/improve.ts:6 (`// [C6]`): "reaches an agent" -> "goes live", plus the
  seat-prompt exception. (The brief said `groups/improve.ts`; the file is `commands/improve.ts`.)

## Left as is, and why
- README:29 "exits 1": measured true for a keyless run; the council's "5" applies to a provider
  refusal, now stated beside it.
- `vitest.config.ts:25-26` and `.github/workflows/ci.yml:118-122` still say "505 files / 2743 tests"
  and call the root run misconfigured: not in this item's file list (ci.yml is in another agent's diff).
- docs/local-models.md:3 and docs/solo.md: C11's pages; the test finds no wrong command or flag in them.
- Hermes "65 curated MCP presets" and "24+ platforms": not re-measured here (ranker 3 counts about 27
  chat platforms, which 24+ does not contradict).
- stage1-C claim 6 (audit covers 1 of 3 chains) and claim 7 (the recall gate exists and the product
  fails it): the README already states the 0.629 < 0.9 result; the three-chain gap is not in the
  README's text and was not added.

## Final verification (after every edit)
- `npx vitest run apps/cli/src/commands/__tests__/docs-truth.test.ts` -> exit 0, 11 passed
- `npx vitest run apps/cli/src/commands/__tests__/docs-truth-pages.test.ts` -> exit 0, 11 passed
- `npx vitest run apps/cli/src/commands/__tests__/registry.test.ts` -> exit 0, 777 passed
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0
- `node scripts/ci/repo-scan.mjs` -> exit 0 (3 of 3 PASS, 1271 files)
File sizes: docs-truth.test.ts 385 lines, docs-truth-pages.test.ts 321, fleet.ts 355, improve.ts 302.
Nothing committed, staged, stashed or pushed. The docs these checks read also carry other agents'
in-flight hunks (C11 in configuration.md, doctor.md, solo.md; C14 in configuration.md); the checks
pass over them as they stand now.
