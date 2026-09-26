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
session with its tool results. A long conversation is compacted by the solo runner itself
(next section); the fleet's compactor, which is not safe for tool output, never touches it.

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
to the thread it came from. A park left by a REPL session that was killed is offered when that session
is continued (`trent solo -c`): `A run is waiting on approval <id>; /resume to continue.` `/resume`
opens its card again, and a yes runs the call and the rest of the turn. A park of another conversation
(a gateway thread) is never offered in the REPL: it is resumed where it belongs.

## Compaction

When the stored conversation passes its threshold, it is compacted before the next turn's first model
call, never beside a turn; `/compact` does the same on demand, under the threshold too. In order:

1. Old tool results (those before the part of the conversation that is kept whole) are replaced by a
   one-line stub naming the tool, its status and its size. No model is called. If that is enough, the
   automatic path stops here.
2. The turns about to be dropped are offered to shared memory (the memory flush). The flush writes
   only through this conversation's own `memory` tool, behind the same untrusted-content gate as the
   model's own writes: if the conversation ever read a web page, an inbound message or other untrusted
   content, every flush write is held as an approval row (`trent approvals list`) instead of written.
3. One summary replaces the dropped turns, under fixed headings (Goal, Constraints, Progress,
   Decisions, Files, Next steps), and one compaction event records what was forgotten. A summary made
   from untrusted turns says so on its first line.

The two model calls are charged like any turn (seat `trent`, the day's ledger, the caps), as their
own run. A run that is waiting on approval is never compacted away. The system prompt (persona, the
memory and brain as they stood when the session opened, the tool protocol) is byte-identical before
and after, so a provider's prompt cache survives; what the flush wrote reaches the prompt of the next
session. Skills loaded with `skill_view` stay loaded (next section).

| Key | Default | Effect |
|---|---|---|
| `agent.solo.compact_after_chars` | half the model's window when it is known (local models), else 64,000 | the threshold, in characters of stored conversation |
| `agent.solo.auto_compact` | `true` | `false` leaves compaction to `/compact` |

## Memory and skills

Each turn's recall (the brain and earlier runs, for this objective) rides that turn's message, never
the system prompt. The `memory` tool writes with provenance: after untrusted content anywhere in the
conversation, a write is held as an approval row, and approving it writes the entry tagged with where
it came from (`[provenance: untrusted via web_extract]`).

The system prompt lists every installed skill by name and one line, never its body. `skill_view`
loads a skill; from then on its text rides every turn of the conversation, read fresh each turn, so it
survives a compaction and a restart.

## Delegation

`delegate_task` runs a child run and hands its answer back as the tool result:

| `agent.solo.delegate` | The child |
|---|---|
| `solo` (default) | a solo run on its own conversation: a new session of the same store (`trent sessions` lists it as `delegated: ...`), or one in memory when the parent has no stored session |
| `fleet` | a fleet run; refused while the conversation is tainted (it read a secret or untrusted content), because a fleet run starts with a clean policy history |
| `off` | refused |

A child sees only its task and the context it was given. It spends from its parent's budget: it may
make only the tool calls its parent has left and spend only the cents left under `budget.per_run_cap`,
and both are added to the parent's turn. Children run one at a time. A child's held calls are refused
(nobody can approve one for it), it is not offered `ask_human` or `clarify`, and its memory, brain and
skill writes are refused: it puts the fact in its answer. It starts from its parent's taint, and what
it reads comes back up, so a secret a child read holds the parent's next network call.
`agent.solo.max_delegation_depth` (default 2: a child and its child) bounds nesting. A wrong value for
`agent.solo.delegate`, `max_delegation_depth`, `compact_after_chars` or `auto_compact` refuses to start,
naming the key.

## Checkpoints

A solo write goes on the same agent-write ledger as the fleet's, as seat `trent`, one checkpoint per
turn, so `/checkpoints` and `/rollback` work in a solo session. After `/rollback` the conversation is
told which turns and files were undone, so the model does not go on believing the files hold what it
wrote.

## Spend and audit

Each run writes one ledger row per model under seat `trent`, so `trent usage --by seat` shows solo
spend on its own line, and `budget.per_run_cap` and `budget.daily_cap` stop a run before another
model call is bought. A local model's calls are priced at zero. Each answer carries its turn's cost, so a solo session's
total in `/sessions` and the `-c` ticker are the meter's.

A solo run writes the audit rows a fleet run writes, through the same call (the app store's
`addAudit`): `orchestration.run_start`, `orchestration.step_start` (the step, and each held call),
`orchestration.step_approved` / `step_rejected` for a decision, and `orchestration.run_done`,
`run_failed` or `run_cancelled`. Where they land is the app store's choice, exactly as for the fleet:
the app's database in connected mode, its in-process store in standalone mode.

## Limits

- Solo on a local model depends on constrained output that has not landed; the live proof on a local
  model and the fleet-against-solo cost table are still to come.
- `trent run --resume` resumes fleet runs only.
- A delegated fleet child is not metered against its parent's per-run cap (it is its own run on the
  ledger); its cents are added to the parent's turn as it reports them.
- Interrupted and failed turns carry no marker in the transcript yet (council A9).
