# Solo mode: a base harness without the nine seats (design, 2026-09-26)

Bobby: "recreate a base harness for people that just want to use it like Hermes without the 9
agents." Sources: 01_discovery/output/harness-{openai,anthropic,others}-2026-09-26.md,
local-models-2026-09-26.md, hermes-feature-inventory-2026-09.md, the tree at HEAD 412f5b0.

## What Hermes-shaped use means
One agent, one conversation that persists across turns, a tool loop (model -> tool calls -> results
-> model until a final answer), skills loaded on demand, memory it can read and write, the same
messaging surfaces (REPL, TUI, chat platforms, cron, A2A), approvals for side effects. No planner,
no critic, no consolidator, no seats. It is also what a local model needs most: one prompt prefix
to prefill and cache, not eleven (local-models-2026-09-26.md, failure mode 3).

## Options
1. **A second runner behind the existing `AgentRunner` port.** `packages/trent-core/src/agent-
   runner/index.ts` already defines `run({objective, signal}) -> AsyncIterable<OrcEvent>`, and every
   surface consumes OrcEvents: the REPL engine, the headless runtime, the gateway, cron, the service
   daemon, A2A, the spend meter, approvals, checkpoints. A solo runner that yields the same event
   kinds (run_start, one step per turn, tool events, run_done / run_failed with the P2-11 verdict)
   makes every surface work unchanged. Cost: the loop itself (~600-900 lines with tests); the
   surfaces only learn a mode switch.
2. **A fleet of one:** the planner emits one step for one seat. Keeps everything, wastes a planner
   and a critic call per turn, and the seat prompt shape is the app's (Company/Seat/Objective).
   Cheapest, but it is not the Hermes shape and it is the wrong cost on local models.
3. **Reuse the app's seat-agent-loop with a synthetic seat.** The loop is in apps/web (read-only),
   642 lines, tied to the app's prompt and record shapes; a wrapper-owned loop is needed anyway
   for constrained output, repair, prompt budgets and local timeouts (L1).

**Decision: option 1.** The wrapper owns a small, testable loop; the app is untouched; every
surface, the ledger and the gate come for free through the port.

## The loop (packages/trent-core/src/solo/)
- `runner.ts`: `createSoloRunner(deps): AgentRunner`. deps = model gateway (`complete`, with the
  pin policy and, on local providers, constrained output from L1), the tool build
  (`buildTrentTools`, adapters with the side-effect gate), the session store, the fleet-memory
  hook pieces (stable tier: identity + persona + brain; context tier: recall for this turn),
  the spend meter, checkpoints, the verdict builder.
- `turn.ts`: one turn = assemble messages (system = stable tier + tool disclosure; history =
  the session's messages after compaction; the new user message) -> `complete` -> parse the
  reply with `tools/action.ts parseAction` (the `<tool> <json>` shape every adapter already
  documents; on local providers the L1 `{tool, args}` schema) -> for each action: the gate (an
  approval parks the run as `input-required`, exactly as seats do), execute, append the result as
  a tool message -> loop until the model answers without an action, or `solo.max_tool_calls`
  (default 25) or the per-run budget stops it. Repeated identical failing calls stop the turn
  (the app's `repeatedToolMisuse` idea, re-implemented).
- `prompt.ts`: the solo system prompt: persona from `<profile>/brain/system/solo.md` (created on
  first run from a default the packs can override), the brain's stable tier, the tool
  disclosure (deferred loading through `tool_search` stays), skills on demand (`skills_list` /
  `skill_view` are ordinary tools), the date and workspace facts. Byte-identical prefix per
  session for prompt caching (P2-7's rule).
- `events.ts`: maps the loop to OrcEvents: `run_start`, `step_start` (one step per turn with
  seat `trent`), `tool_call` / `tool_result`, `step_note`, `run_awaiting_approval`, `run_done`
  with the final answer as the run's artifact, `run_failed` with the verdict.
- Memory: recall for the turn through the existing brain index; writes through the memory tool
  with provenance and holds, unchanged. Session continuity: the REPL/gateway session id is the
  conversation; compaction from `sessions/compaction.ts` applies to solo messages; `/compact`
  and `session_search` work.
- Delegation: `delegate_task` in solo spawns a child solo run (or a fleet run when the config
  says so) with its own budget; no nested seats.

## Surfaces and configuration
- `agent.mode: fleet | solo` (default fleet; `trent setup --mode local` recommends solo).
- `trent --solo` / `trent run --solo "..."` override for one launch; `trent solo` is an alias
  that starts the REPL in solo mode. The REPL banner names the mode and the model.
- Headless runtime, gateway, cron, service daemon, A2A and ACP pick the runner by mode: one
  factory `createRunnerForMode(config, deps)` in apps/cli/src/runtime.
- Spend: one ledger row per turn, seat `trent`; caps apply; `trent usage --by seat` shows it.
- Approvals: the same approval rows and cards; a held call parks the run; the answer continues
  the same session (the REPL and gateway already do this for seats).
- Checkpoints and `/rollback`: the same write ledger.

## Tests (red first)
- Loop: fake gateway scripts (answer; one tool then answer; three tools; a gated tool -> parked
  -> resumed; malformed action -> repair -> retry once -> failed turn; max_tool_calls; budget stop;
  abort signal); every OrcEvent kind the surfaces rely on is emitted in order.
- Surfaces: REPL renders a solo turn; gateway routes a message to solo; cron runs a solo job;
  A2A serves a solo task; `--solo` and `agent.mode` agree; the ledger row shape.
- Local: on the pulled 9B model, a three-turn conversation with one tool call each, tokens and
  cents printed; the same on the fleet mode for the cost comparison (expected: solo prefill is a
  fraction of fleet's).

## Waves
- S1 core loop + runner + events + prompt (one agent).
- S2 surfaces + config + CLI flags + docs-truth counts (one agent), after S1's types exist.
- S3 session continuity, compaction, memory, skills on demand, delegation, checkpoints in solo
  (one agent), after S1.
- S4 docs (docs/solo.md, README row, getting-started), the local live proof, the fleet-vs-solo
  cost table (one agent), after S2 and S3.
- A council-style adversarial review of this design by one Opus agent runs alongside S1; its
  findings adjust S2-S4.

## Not in solo
The planner, critic, consolidator, seats, seat capabilities, packs' seat rosters, improvement
sweeps over seats (the curator and skills still apply). Everything else is shared.
