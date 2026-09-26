# Solo mode

Solo mode runs Trent as one agent with one tool loop and no seats: no planner, no critic, no
consolidator. You type, the agent calls tools until it has an answer, and it answers. It uses the
same tools, the same side-effect gate, the same memory and brain, the same spend ledger and the same
approval rows as the fleet. The design is `02_plan/output/solo-harness-design-2026-09-26.md`; the
review that shaped it is `02_plan/output/solo-harness-review-2026-09-26.md`.

## Turning it on

| How | Scope |
|---|---|
| `agent.mode: solo` in `config.yaml` | every surface of this profile, until you change it back |
| `trent solo` | the REPL, for this launch |
| `trent --solo` | the REPL, for this launch (`-c` and `--profile` work as usual) |
| `trent run --solo "<objective>"` | one run |
| `--solo` on `trent cron run`, `trent cron start`, `trent gateway start`, `trent a2a serve`, `trent acp` | that process |

A launch flag beats `agent.mode`, which beats the default `fleet`. The flag writes nothing: the next
launch without it is back on `agent.mode`. `--solo` is a global flag, so every command accepts it;
the commands not listed above (`trent service daemon`, `trent heartbeat`, `trent jobs`, `trent goal`,
`trent mcp serve`) follow `agent.mode`. The TUI (`trent --tui`) runs the fleet only.

The REPL's banner says which runner you are on: `solo · <model>` or `fleet · 9 seats`.
`trent run --json` and the `system` line of `--format stream-json` carry `"mode"`.

## The conversation

In the REPL and in each gateway thread the conversation is that session's transcript
(`trent sessions`), and the solo runner is its only writer: every user line, every tool call, every
tool result and every answer is stored once, as the model saw it. `trent solo -c` continues the last
session with its tool results. The REPL does not compact a solo session yet; the fleet's compaction
is not safe for tool output and is switched off in solo (a later wave replaces it).

Each conversation has its own runner: a message in one chat thread never cancels or resumes a held
call in another. `trent run`, a cron job and a heartbeat are one-off conversations.

## Held calls, by surface

A call the gate holds (a send, a payment, a customer action, a call under `autonomy`) waits for a
person. Where no person can answer, it is refused instead of parked, and the model is told
`not run: no human is attached to this surface to approve it`. No approval row is filed for a
refused call.

| Surface | A held call |
|---|---|
| REPL | an approval card per held call; `y` or `n` |
| gateway | a card to `gateway.owner`; refused when no owner is set |
| `trent run` | parks on a terminal (exit 7, decide with `trent approvals`), refused in a script or a pipe |
| A2A | an `ask_human` or `clarify` question sets the task `input-required` and the caller's next message on the task answers it; every other hold is refused (a peer never approves a side effect) |
| ACP, cron, the heartbeat | refused |

A parked run is saved beside its session, so a restart does not lose it. For a gateway thread,
deciding its row with `trent approvals approve <id>` or `reject <id>`, from any process, is picked up
by the running gateway on its next drain tick (about a second): it resumes the run and posts the reply
to the thread it came from. A park left by an earlier REPL session is kept but not resumed by the REPL.

## Spend and audit

Each run writes one ledger row per model under seat `trent`, so `trent usage --by seat` shows solo
spend on its own line, and `budget.per_run_cap` and `budget.daily_cap` stop a run before another
model call is bought. A local model's calls are priced at zero.

A solo run writes the audit rows a fleet run writes, through the same call (the app store's
`addAudit`): `orchestration.run_start`, `orchestration.step_start` (the step, and each held call),
`orchestration.step_approved` / `step_rejected` for a decision, and `orchestration.run_done`,
`run_failed` or `run_cancelled`. Where they land is the app store's choice, exactly as for the fleet:
the app's database in connected mode, its in-process store in standalone mode.

## Limits

- Solo on a local model depends on constrained output that has not landed; the live proof on a local
  model and the fleet-against-solo cost table are still to come.
- `trent run --resume` resumes fleet runs only.
- `delegate_task` in solo has no child runner yet.
