# 2026-09-12 — Trent Fleet v2 build (Master Prompt v2 + Implementation Plan v2)

## Governing documents
- `~/Downloads/Trent Fleet Master Prompt v2.md` — identity, model routing, 10 anti-patterns, 7 superpowers phases, ICM overlay, 13 coding rules, completion criteria.
- `~/Downloads/Trent Fleet Implementation Plan v2.md` — ICM stage contracts, Stages 00-14.
- `apps/web/CLAUDE.md` + `apps/web/AGENTS.md` — the pre-existing app's own rules. These OUTRANK the v1 spec docs.
- Prior audit: `docs/sessions/2026-09-12-antigravity-audit.md`.

## Rules in force
Fable/top model orchestrates; Opus subagents execute. Max 6 agents concurrently. No code before design approval (hard gate, stated in both the prompt and the brainstorming skill). Failing test first. Explicit-file staging. No push/merge/deploy without authorization.

## Stage 00 — Discovery and Baseline (IN PROGRESS)

### Completed
- ICM workspace created: `01_discovery/` through `05_release/`, each with `output/`.
- **Design tokens extracted** from `apps/web/app/styles/base.css` -> `01_discovery/output/design-tokens.json`.
  obsidian #0A0A0F, ink #11111A, steel #1B1B26, slate #262633, haze #4A4A57, mist #94A3B8,
  bone #F1ECE2, bone-2 #E6E0D3, pulse #6EE7B7, pulse-deep #10B981, ember #FB923C, ember-deep #EA580C,
  danger #F87171. Fonts Inter / JetBrains Mono / Instrument Serif. Radii 6/14/22/32.
  The v1 docs' #8B5CF6 purple and #0F1117 are NOT the app's tokens and are forbidden (anti-pattern #5).
- Baseline commit recorded: `ed94ae8ea7297a3a86e7bf96c59539e578d11f2b` (single squashed commit, no remote).
- **Repo instruction constraints** captured -> `01_discovery/output/repo-instructions.md`.
  Files <500 lines; `npm run typecheck` before commit; `makeId()`/`nowIso()`; withRlsContext for tenant
  data (no-op on SQLite); auth rate limit fails CLOSED; spend reservation is a TOCTOU guard; audit log
  is a serializable transaction. **The app already supports both Postgres and SQLite.**
- **Model gateway contract** -> `01_discovery/output/model-gateway-contract.md`.
  The streaming core is CLI-safe: model-gateway -> ai-client -> model-policy import only node:crypto,
  openai, zod. Real streaming entry is `routeWorkbenchStream` + `streamArtifactWithFallback` ->
  `streamAnthropicMessages` / `streamOpenAiCompatibleChat`. Five traps documented, chief among them:
  `MODELS`/`MAX_TOKENS` freeze at import time, so secrets must reach `process.env` before the import;
  and `ai-proxy/openai-compatible.ts:93` returns a CANNED response, so the CLI must never route through it.
- **lib/ wrapping matrix** -> `01_discovery/output/lib-wrapping-matrix.md`.
  4 modules import clean, 2 need only an LLM adapter (both have `skipLLM`), 3 need a DB.
  8+ wrappable, so anti-pattern #2 is satisfiable. 13 Prisma models total, but only 4 tables
  (agentTrace, skillDraft, selfImprovementIteration, auditLog) are needed for the self-improvement loop.

### Pre-existing bug found (report, do not silently fix)
`apps/web/lib/heartbeat.ts:335-336` builds fresh in-memory stores for the sweep inside
`runCompanyHeartbeat`, so the production self-improvement sweep always reads an empty trace store.

### Still running (Opus agents)
orchestrator contract; baseline build/test + Prisma-SQLite feasibility; git-history restoration plan;
Bun-compile + Tauri v2 feasibility; web visual-language + brand assets.

### Next
Synthesize all seven discovery reports -> `01_discovery/output/codebase-audit.json`, then Stage 01:
present 2-3 approaches and the design for approval. No code until approved.

### Baseline verified (executable evidence)
| command | result |
|---|---|
| `cd apps/web && npx next build` | **exit 0** |
| `cd apps/web && npm test` | **exit 0** — 505 files / 2743 tests passed, 125 skipped |
| root `npx vitest run` | exit 1 — 2 phantom failures; root config sweeps apps/web tests without their setup file. **Do not use as the gate.** |
| `prisma validate` on a sqlite-flipped copy | "valid" — `migrate diff` emits 64 CREATE TABLEs + 95 indexes |

Environment: node v26.8.2 (apps/web engines declares 22.x), npm 11.19.1, cargo 1.75.0.
**bun is NOT installed. Docker is installed but the daemon is NOT running** (`docker info` exits 1),
which blocks live Docker-backend tests on this machine.

### Persistence decision input
SQLite is viable with zero schema incompatibilities: 0 `@db.*`, 0 `Unsupported()`, 0 scalar arrays,
0 Decimal/BigInt/Bytes (money is Int cents), no pgvector/citext/full-text. Runtime caveats only:
no JSON-path filtering, no `mode:"insensitive"`, no concurrent writers.
Recommended: generate `schema.sqlite.prisma` from the canonical schema via script so it cannot drift.

Hazard: `apps/web/lib/db.ts:11` assigns `globalThis.__prisma` whenever NODE_ENV !== production, so a
CLI importing it inherits the web singleton and cannot point a second client at SQLite in-process.
The CLI needs its own client factory.

### Orchestrator (major finding)
No Postgres and no Redis required — `store.ts:11` falls back to memStore, `queue.ts:669` runs jobs
inline. DI seam already exists at `lib/runtime-eval-overrides.ts`, and
`lib/orchestration-eval-integration.ts:29` is production code that launches and drains a run.
**There is no `runOrchestration()`** — the plan's assumed API is one our wrapper must create.
20 event kinds on an in-process bus (`subscribeOrcEvents`) drive the CLI's live agent lines.

### Credential blocker
`~/.trent/.env` holds a 16-character placeholder Anthropic key. Doctor reported it green — more
evidence for anti-pattern #8. User must supply a real key for the two live-model tests; everything
else proceeds offline.

---

## Stage 02 — Branch and history restoration (COMPLETE)
- Feature branch `feature/trent-fleet-v2` created off the restored history.
- **Git history restored: 174 commits.** Built in a scratch clone, imported with a single
  `git reset --mixed` (never writes the working tree). Verified: 3236 files matched as exact renames
  (0 adds, 0 deletes), `git log --follow` crosses the move, authors preserved
  (Bobby Meher 159, Claude 12, Codex 1).
- **Recovered 11 source files** the previous agent silently dropped when a new root `.gitignore`
  swallowed the artifacts API routes and their tests. Two needed NUL-delimited handling because of
  em-dash filenames (the macOS unicode hazard).
- Secret sweep across all 174 commits: clean. The one hit, `sk-ant-api03-abcdef987654321`, is a
  fixture inside the OTel redaction test asserting that secrets get stripped.
- Pushed to `DreadpiratePickles/trentbalone` (**private**). Local and remote in sync at 174 commits.
- Machine note: a global `credential.username = test-user` blocked the push; overridden locally only.

## Stage 02b — ICM scaffolding completed (was missing)
A re-read of the two governing documents exposed that I had skipped required artifacts. Now written:
`AGENTS.md` (layer 0), `CONTEXT.md` (layer 1), five stage contracts in the required
Objective/Inputs/Process/Outputs/Verify/Approval/Failure format, `codebase-audit.json`
(14 modules, verbatim signatures, 0 next imports, anti-pattern 2 satisfiable),
`02_plan/output/design-doc.md`, and `implementation-plan.md` (superpowers phase 3, 2-5 minute tasks
each naming the failing test and its expected failure message).

## Stage 03 — Implementation

### Task 1.1 — standalone env contract (COMPLETE, GREEN)
RED first. A guard test forces `NODE_ENV=production` to imitate a compiled binary and **reproduced the
double-execution bug**: `run_done` emitted more than once while the run still reported `completed`.
Without that guard the contract test would pass vacuously, because vitest's own `NODE_ENV=test`
suppresses the fallback. The two contract tests then failed on the missing module — the correct RED.

Implemented `packages/trent-core/src/runtime/env.ts`: `applyStandaloneEnv`, `assertStandaloneEnv`,
`IN_MEMORY_DATABASE`. Note `applyStandaloneEnv(":memory:")` deliberately LEAVES `DATABASE_URL` unset,
because `store.ts:11` selects the Prisma store whenever that variable is present.

| check | command | result |
|---|---|---|
| core runtime tests | `npx vitest run packages/trent-core/src/runtime` | 3 passed |
| regression gate | `cd apps/web && npm test` | 505 files / 2743 tests passed |
| web typecheck | `npm run typecheck` | exit 0 |
| core typecheck | `npx tsc -p packages/trent-core/tsconfig.json` | 0 errors |

Also fixed: `packages/trent-core/tsconfig.json` now MIRRORS `apps/web/tsconfig.json` compilerOptions
(dom lib, bundler resolution, isolatedModules) so files imported from apps/web type-check identically
in both places. Diverging them again will reintroduce phantom errors.

### Tasks 1.2-1.7 — dispatched in parallel (6 Opus agents, at the cap)
1.2 error taxonomy + exit codes + secret-redacting envelope · 1.3 ConfigManager rebuild
(the `loadSecrets` never-writes-process.env bug is the headline) · 1.4 model gateway live streaming
against the verified Gemini key · 1.5 Prisma-on-SQLite store with the vendored bun:sqlite adapter and
a restart-durability test · 1.6 orchestrator wrapper with an owned drain loop · 1.7 wrap the remaining
eight lib modules plus the anti-pattern-2 import-graph test.
Agents do not commit; the orchestrator reviews and commits.

### Milestone 1 COMPLETE — 6 tasks, 145 tests, all test-first
| task | tests | the evidence that makes it real |
|---|---|---|
| 1.1 env contract | 3 | a guard test REPRODUCED the double-execution bug before the fix |
| 1.2 error taxonomy | 18 | secrets redacted by key name AND by value shape, recursively |
| 1.3 config rebuild | 25 | loadSecrets never wrote process.env, silently defaulting every model name |
| 1.4 live gateway | 13 | real Gemini tokens, real usage, asserted NOT to be the canned proxy string |
| 1.6 orchestrator | 8 | a real 3-step run, 2 agent roles, exactly one run_done |
| 1.7 wrappers | 47 | **19 lib modules wrapped, counted from the import graph, floor is 8** |
| 1.5 sqlite store | 23 | **a run survives a process restart** — closes review finding C-1 |

Notable finds during the milestone:
- `apps/web/lib/ai-client.ts:73`'s hardcoded google default `gemini-2.0-flash` is **retired and 404s**;
  `gemini-2.5-flash` is refused for new keys. Every new Google key on the platform hits a dead model.
- The same file requests usage reporting only for openai, so Google streams carry no usage; the
  wrapper estimates and marks `estimated: true` rather than pretending.
- Upstream Prisma 6.19.3 defect: `migrate diff` emits SQLite Json defaults as bare `DEFAULT {}`, which
  SQLite rejects. The derivation script quotes them and throws if any survive.
- `better-sqlite3` cannot compile against Node 26 here, so the store is proven on the REAL bun runtime
  as a child process rather than against a driver we do not ship.

### Machine change
Bun 1.4.2 installed to `~/.bun` (it is the SQLite runtime and the binary compiler). Its installer
appended 6 lines to `~/.zshrc`; kept this time because bun is now a genuine project dependency.
Backup at `<scratchpad>/zshrc.before-bun-install`.

### Hermes source read (Layer 3 reference committed)
Their repo: 272 MB, 12,778 files, Python agent + TS/TSX TUI and Electron desktop.
**They have NO egress credential isolation at all** — no TLS interception, no CA injection, no
allowlist, and docker-compose runs `network_mode: host`. That makes our egress proxy a differentiator
rather than parity work. Also adopted: their subshell installer-frame guarantee, approval floors that
fire before bypasses over deobfuscated command variants, and persist-before-execute in the tool round.
Rejected: unpinned curl-to-bash with no checksums, two divergent installers, a doctor that exits 0 on
failure, and an unbounded iteration default.

### In flight (6 agents)
doctor rebuild · setup wizard · CLI visual foundation · TLS egress proxy · CI pipeline · session privacy.

### Milestone 2 — doctor COMPLETE (63 tests, 13 checks)
The proof is that it now FAILS on this machine where it used to be all green:
`FAIL Credentials` (the 16-char placeholder), `FAIL Environment` (queue fallback not disabled),
`FAIL Workbench` (Docker daemon down). Live exit code 3.

Layered deadlines because Hermes's doctor is documented to hang: an AbortSignal on every fetch AND a
Promise.race timer, 15s per check, 60s for the run. Three deliberately wedged checks still return a
full report in under 5s. Added `doctorExitCode` (non-zero on failure) and `renderJsonReport` — Hermes
has neither, which is why their doctor cannot gate CI.

The phantom log-prune fix hint was deleted rather than implemented.

### Milestone 2 — setup wizard COMPLETE (14 tests)
Three real interactive modes behind a PromptPort so tests script answers with no TTY. The port makes
`default` a REQUIRED field on every question, so forgetting to pre-fill is a compile error.
Quick mode does not fake OAuth; with no keys it names the env vars and the .env path and writes nothing.
Blank Slate writes all three explicit disable lists.
Fixed the unit bug the config rebuild exposed: `10.0` in a cents field made a $10 cap into 10 cents.

### CLI visual foundation COMPLETE (48 tests, mutation-checked)
Inventing a hex fails 3 tests; deleting the state-outranks-identity rule fails 1; leaking a colour
code into monochrome mode fails 11. Found a real palette collision: `marketing` is the ember hex and
`product` is the pulse hex, so a category is demoted to mist when it would clash with the state signal.

### Infrastructure
`agent.let-trent.uk` created as a proxied CNAME to GitHub Pages. It serves nothing until Milestone 5;
the record exists and is reversible.
No VM needed — CI runners provide the one thing a single Mac cannot: running each cross-compiled
binary on its real OS.

---

## Late session, 2026-09-12 -> 2026-09-13 — state at context compaction

### Everything shipped since the last log entry (all on `feature/trent-fleet-v2`, 52 commits, pushed)
| piece | evidence |
|---|---|
| REPL wiring fixes | 116 tests; shipped `trent` reaches the configured model with only the key set; can approve; a run where every call fails says failed |
| Boot-sequence banner | 72 ui tests; animated, skippable, static when piped; installer banners pre-rendered from the same fn |
| Installer | 33 tests, real script in a scrubbed shell against a signed local release; tamper/wrong-signer/redirect/truncation/root refused; minisign + ECDSA co-sig because stock macOS LibreSSL has no Ed25519; one manifest renders sh and ps1 |
| `trent desktop` + real updater | 315 tests; same embedded key as the installer; correct checksum + invalid signature REFUSED; real DMG mounted in test; versioned layout `versions/<v>/` + `current` pointer, aligned installer/updater |
| Messaging gateway | 8 real transports, 67 tests against local servers speaking each platform's wire protocol; nonced approvals need a paired admin; pairing codes; circuit breaker; durable queue |
| Self-improvement loop | all four disconnected pipes wired from the wrapper (`src/improve/`): traces per step, sweep on real stores, eval gate that EXECUTES candidates (deterministic graders first, LLM judge second), golden capture, stale/archive/rollback + hash ledger, protected seat prompts, fleet scope (9 seats continuous, specialists while installed). Live sweep ran: 3 Gemini calls. `trent improve` CLI |
| Planner/critic/consolidator on the configured model | 8 calls for a 3-step run (was 4); live: Gemini planned, critiqued, consolidated. Consolidator had no seam -> wrapper-side replacement on the fallback literal |
| **Tools — the user's top priority** | 35-line sanctioned seam in `apps/web/lib/{tools,semantic-router}.ts` (own commit, +4 web tests, suite 2747). `src/tools/`: approval-floors (deobfuscated matching), file_ops, terminal (Docker cap-drop ALL, network none, egress via proxy), web (SSRF floors, metadata IPs refused with zero connections), memory, skills, cron. 129 tests. **Live: Gemini itself emitted `read_file {"path":"package.json"}`** and got real bytes. LocalBackend was forwarding the ENTIRE env to children — now scrubbed |
| CI | all 4 binaries build; native runs died on launch with `@prisma/client did not initialize` because the web client was never generated before compile (41 MB vs 97 MB). Fixed in workflow + a build preflight that refuses without generated clients. Guard fixed (GNU grep -H), lint scoped to CLI typecheck, scanner uses `\p{Extended_Pictographic}` and reads the style contract; core roles recoloured off the forbidden purple |
| Test infra | root vitest is allow-list; two exclusive-resource suites (prisma generate, hdiutil) in their own sequential project; live suites behind `TRENT_TEST_LIVE=1`; no double collection; stale DMGs detached |

### Model facts (verified on this key)
Only Google's OpenAI-compatible endpoint works; native REST 404s. `gemini-3.5-flash-lite` -> 200 (default). `gemini-3.6-flash` -> 429 free-tier. `gemini-2.5-flash` -> 404 retired for new users. Free tier rate-limits; live tests skip on 429.

### Still open
- REPL tools+egress wiring (agent in flight): pass `buildTrentToolAdapters` + a started `EgressProxy` to `createOrchestrator`; `/tools` lists real adapters.
- Stanford CS329A applied brief (agent in flight) -> `01_discovery/references/cs329a-applied.md`; then implement the ranked additions in `src/improve/`.
- TUI: still canned replies; the user's own session owns the rewrite; the repo scan fails on it by design until it lands.
- Remaining Hermes toolsets: delegation alias, vision/browser (need services), code_execution (phase 2), plugins (phase 3).
- Pre-existing apps/web quirk: `checkExternalActionInputGuardrail` blocks any action containing "post"/"send"/"dm" — e.g. `read_file` on `posthog-*.ts`. Not fixed; outside the sanctioned edit.
- Cost ledger prices at Anthropic tier (~100x over on Gemini); needs a Gemini row.
- `trent-sandbox:latest` image does not exist; tests use `alpine:3`.
- CI run 34733200522 pending on 85bfb12.

### Rules in force (memory files: work-autonomously, max-six-agents, use-opus-for-agents, escalation-options)
Never ask permission to proceed. Opus subagents, max 6, Fable only at real forks. Failing test first. Explicit-file staging. apps/web read-only except a tested seam in its own commit. No emoji in output; brand palette only. Never log a secret.

### In flight at compaction (2026-09-13) — pick these up from their reports, then commit
1. **Improve-loop foundation** (Opus): tasks I.1-I.5 + I.17 from `01_discovery/references/cs329a-applied.md`
   §6 — real cost accounting, budget cap, persisted baseline + judge caches, and **`blockedBy:"unverified"`
   when nobody verified a candidate** (the vacuous-gate fix). Also `SKILL_INJECTION_ENABLED=1` in
   `applyStandaloneEnv` so promoted skills reach seats, and `evalScore` populated in traces.
   Owns `src/improve/`, improve tables in `src/store/`, `src/runtime/env.ts`.
   **Next after it lands:** tasks I.6-I.16 (mechanical-grader overlay, evidence-cited judge +
   meta-verification, judge/human agreement ledger, per-fixture cluster tags, saturation skip,
   length guard, second-draw reliability, clean-trace distillation, rationalisation on goldens,
   repetitive-loop tag, public/private suite split).
2. **Fleet shared memory** (Opus): new `src/fleet-memory/`, `src/tools/memory/`, a prelude hook in
   `src/orchestrator/index.ts`. One company memory read by every seat (subagents read-only),
   cross-agent recall as a frozen budgeted snapshot (3,000 chars, config), `fleet_search` over all
   agents' outputs, org-tier skills visible to all, entry-level merge for concurrent writers.
   Not shared: seat prompts, per-agent GEPA frontiers, secrets.
3. **REPL tools + egress wiring** (Opus): `apps/cli/src/repl/`, `commands/groups/servers.ts` — pass
   `buildTrentToolAdapters` and a started `EgressProxy` to `createOrchestrator`; `/tools` lists real
   adapters; proxy stops on exit including throw and Ctrl+C.

Commit order once they land: seam-free core first (1 and 2 together if they typecheck), then REPL.
Then push, check CI run on the latest sha, and start I.6-I.16.

### 2026-09-13 — REPL tool wiring COMMITTED (commit 56)
Agent in the terminal reads a file live through file_ops with egress brokered; proxy up before first
turn and down after exit (throw and Ctrl+C included). 99 REPL tests. Sandbox floor is alpine:3.
Doctor's workbench check uses `docker image inspect`, which reports No such image on this daemon
while `docker inspect --type image` works — fix when next in src/doctor.
Remaining in flight: improve-loop foundation (I.1-I.5, I.17), fleet shared memory.

## 2026-09-13 — post-compaction resume

- Committed the fleet shared-memory work as `3ef24cb` (10 files / 75 tests, tsc clean, 3-test live
  suite on gemini-3.5-flash-lite; ceo seat wrote a fact, support seat recalled it next run). Details in
  `docs/sessions/2026-09-13-fleet-memory.md`.
- In flight (two Opus agents, ≤6 rule respected):
  1. Stanford tasks I.6–I.12 + `hook.seatModel` wiring — owns `src/improve/**`, `apps/cli/src/commands/improve.ts`.
  2. CLI wiring of `deps.fleetMemory` (REPL + run path), Gemini price rows in the ledger, doctor
     `docker inspect --type image` fix — owns `apps/cli/src/repl/**`, `src/doctor/**`, pricing overlay.
- Still pending after those: I.13–I.16, remaining Hermes toolsets (delegation alias, vision/browser,
  code_execution, plugins), README/docs refresh (README still says "no installer" — stale), CI green on
  latest sha (runs before 3ef24cb were cancelled by concurrency, not failed).
- `notes/` at repo root is untracked user material (Stanford transcripts); left untracked, not mine.
- Landed since resume: `2c56ed5` (fleet memory in REPL, Gemini price rows, doctor image probe),
  `6393486` (Stanford I.6–I.12), `f03dc03` (execute_code / delegate_task / plugins), `a01cbab`
  (Stanford I.13–I.16 — the 17-task plan is complete). In flight: DelegatePort binding +
  `trent-sandbox` image with python3/node.
- Known open after that: README/docs refresh (README still says "no installer"), `apps/cli/src/slash`
  and `tui` violations (user's TUI session owns them), vision/browser toolset (needs a service),
  seat-step pricing inside the app's executeSeatModel still tier-priced.
