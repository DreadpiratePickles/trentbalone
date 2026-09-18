# Implementation plan: Hermes parity, nine seats, shared brain, self-improvement

Approved by Bobby on 2026-09-18 ("approved") against
`02_plan/output/hermes-parity-roadmap-2026-09-18.md` v2. Decisions taken as approved with the
roadmap's recommendations: (1) build the TypeScript harness, Hermes interop later over the A2A spec;
(2) `sales` is the ninth seat, `browser` a toolset; (3) a scoped invariant 1 exception for the seat
shrink in `apps/web/lib/orchestrator-runtime.ts` (one file, own commit, tests); (4) seat eval suites
are drafted by agents from real failures and existing skills and stay quarantined until Bobby
promotes them; (5) `apps/cli/src/slash/` is merged where a command is real and deleted otherwise;
(6) sweep cap defaults from `budget.per_run_cap`, the judge uses a different Gemini model from the
executor on the existing key (a different model, not yet a different family; recorded as a limit),
the embedder may use the Gemini embedding endpoint on the existing key. Any of these can be reversed
by Bobby at the next gate.

Rules for every task: one Opus agent, a written brief (roadmap section 5), failing test first,
files under 500 lines, no canned strings, apps/web read-only except B1, no subagents, no commits.
The orchestrator isolates each commit on a detached worktree of HEAD, commits with explicit paths,
pushes, watches CI. Budget per task is an agent-token ceiling; a task past its ceiling stops and
reports. Waves hold at most six agents with disjoint file ownership.

## Wave 1 (now)
| Id | Task | Owns | Failing test that defines done | Budget |
|---|---|---|---|---|
| A1 | Context management, three-tier prompt, per-seat prelude, personality in the volatile tier. Spike first: find every seam where the wrapper can bound or compact a step prompt and the session transcript, and what is read-only in `apps/web/lib/seat-agent-loop.ts`. | `packages/trent-core/src/fleet-memory/**`, `orchestrator/**`, `model-gateway/index.ts` (cache_control only), `apps/cli/src/repl/**`, `apps/cli/src/runtime/headless.ts`, `sessions/**`, `personalities/**`, `improve/protected-prompt.ts` | A run whose transcript exceeds the ceiling emits one compaction event carrying forgotten ids and a summary, keeps tool call/result pairs together, and the next seat call's prompt is under the ceiling; a second seat in one run gets its own recall, not the first seat's; the personality suffix appears after the prelude. | 500k |
| A2.1 | Workspace context files: `AGENTS.md`, `CLAUDE.md`, `.trent/*.md` from the cwd, loaded only after the prompt-injection scanner passes them and the workspace is trusted (trust before load, persisted per path hash). Module and CLI only; the prelude wiring is one line A1 adds. | new `packages/trent-core/src/workspace-context/**`, `apps/cli/src/commands/groups/workspace.ts`, `docs/configuration.md` section | An untrusted cwd yields no context and a prompt to trust; a trusted cwd with a flagged file yields the clean files and a named refusal for the flagged one; a trusted clean cwd yields the files in the stable-tier order. | 250k |
| A2.2 | Autonomy level and hooks: `autonomy: ask_always \| ask_dangerous \| never` wrapping the app's `orchestrator-autonomy-gate.ts` with approval floors and a hardline blocklist below every bypass; `approvals.deny` globs; user hooks pre and post tool call and session start and stop, shell hooks with consent; `trent hooks list`. | `packages/trent-core/src/config/schema.ts`, `defaults.ts`, `tools/approval-floors.ts`, `tools/index.ts` dispatch, new `hooks/**`, `governance/**`, `apps/cli/src/commands/groups/hooks.ts`, `docs/security.md` | `autonomy: never` still refuses a hardline-blocked command and a denied glob; `ask_dangerous` auto-approves a read and asks for a write; a pre-tool hook that exits non-zero blocks the call and a post hook sees the result; an unconsented shell hook never runs. | 350k |
| B1 | Unshelve analyst, finance, escalation, sales in `apps/web` under the scoped exception; fix the CLI roster (`sales` in, `browser` out as a seat and documented as a toolset); keep traces and seat wiring consistent. | `apps/web/lib/orchestrator-runtime.ts` and its tests, `packages/trent-core/src/fleet/AgentInstaller.ts`, `orchestrator/seat-wiring.ts`, `traces/trace-store.ts`, `docs/fleet.md`, `README.md` fleet lines | A plan step assigned to analyst runs on analyst (no remap); `trent fleet list` shows nine seats including sales and no browser seat; the web suite stays green. | 250k |
| B0.2 | Unify the two skill stores so `trent skills install` and `skill_manage` read and write one store. | `packages/trent-core/src/tools/skills/**`, `skills/**`, `apps/cli/src/commands/groups/skills.ts`, `docs/skills.md` | A skill installed by the CLI is listed, viewed and editable by `skill_manage`, and one authored by `skill_manage` appears in `trent skills list`. | 200k |
| A0.6 | Leftovers: doctor hint for a persisted non-minimal egress root; `cron start` and `heartbeat start` claim SIGINT like `gateway start`; the default block limit override (`MEMORY_CAPS`) honoured. | `packages/trent-core/src/doctor/checks/**`, `apps/cli/src/commands/groups/cron.ts`, `heartbeat.ts`, `tools/memory/blocks.ts`, `docs/doctor.md` | Doctor names a bad root and the fix; SIGINT on cron start runs shutdown before exit 130; a configured limit for the default memory block is enforced by the writer. | 150k |

## Wave 2 (after A1 and A2 land)
| Id | Task | Failing test that defines done |
|---|---|---|
| A1.2 | `/context` inspector and pressure warnings in REPL and TUI; `cache_control` on the stable tier for Anthropic. | `/context` reports tier sizes matching the assembled prompt; a run at 80 percent of the ceiling prints a warning once. |
| A3 | `tool_search`, `tool_describe`, `tool_call` progressive disclosure; `todo`; multi-question `clarify`; `session_search` over FTS5. | With 40 MCP tools registered the seat prompt lists three bridge tools, and `tool_call` reaches the real tool. |
| B2 | Seats as different capabilities: per-seat adapters and floors from the app's manifests, budget in cents aborting the seat loop, model tier from config tiers, verifier suite id per seat. | A seat over its budget aborts with the spend named; the finance seat cannot call `terminal`; engineer and ceo resolve different models when tiers differ. |
| D0 | Improvement gates: frozen surface by path, holdout split, pass^k, post-promotion auto-rollback, content-hash veto, TPR/TNR reporting. | A draft touching a frozen path is refused; a promotion that regresses the holdout is rolled back automatically; a rejected hash cannot be re-proposed. |
| E1 | Checkpoints and `/rollback` with an agent-write ledger. | Every agent write is ledgered; `/rollback` restores the pre-turn files byte-exact. |

## Wave 3 (after B1, B2, D0)
| Id | Task | Failing test that defines done |
|---|---|---|
| C1 | Wrap the app's tier writes and reads (`memory-tiers`, `active-documents`, `capability-memory`, `seat-memory-registries`, `ceo-decision-journal`, `trench-wiki` reads). Bun-only acceptance. | Under Bun, a seat's episodic write appears as a `Document` row and is recalled by the next run. |
| C2 | Brain repository `<profile>/brain/` git-versioned, `system/` always loaded, file tree as signposts, FTS5 index, one-time block migration. | After migration `MEMORY.md` content lives in `brain/system/`, the prelude shows the tree, and a commit exists per write. |
| C3 | Core embedder behind `EmbedFn` (Gemini, OpenAI, none) with lexical fallback and a doctor line. | Recall ranks a paraphrase above a keyword collision when the embedder is on; with none configured the doctor says lexical. |
| C4 | Delta-only memory writes and the write gates by layer; lock bypass and dead env reader closed. | Consolidation emits entries, never a whole-block rewrite; a semantic write outside consolidation is refused. |
| D1 | Every seat can promote: suites from `SLOT_ENVIRONMENTS`, drafted suites per seat in quarantine, reflection on under the cap. | A seat with a promoted suite and a passing holdout can promote; a seat without one is blocked with `no_suite` naming the seat. |
| C5 | Provenance tags and propagation: untrusted-derived output cannot reach shared layers without approval; failures get a recall class. | A memory write from a step that used MCP is held for approval; a failed step is recallable as a failure. |

## Wave 4
D2 heartbeat-driven metered sweep; D3 curator first cut; D4 goals with shell gates and the judge
model; D5 tool-description proposals; E2 `approvals.deny` audit command; E3 A2A spec transport.
Each gets its failing test in its brief when the wave is opened.

## Live proofs
One per phase on Bobby's key with `TRENT_TEST_LIVE=1`: A, a two-turn REPL conversation where the
second turn refers to the first; B, one run touching analyst and finance; C, a recall that needs
the embedder; D, one sweep that promotes nothing without a holdout and one that does with it.
