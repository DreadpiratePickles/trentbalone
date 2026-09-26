# Solo mode

Solo mode runs Trent as one agent with one tool loop and no seats: no planner, no critic, no
consolidator. You type, the agent calls tools until it has an answer, and it answers. It uses the
same tools, the same side-effect gate, the same memory and brain, the same spend ledger and the same
approval rows as the fleet. The design is `02_plan/output/solo-harness-design-2026-09-26.md`; the
review that shaped it is `02_plan/output/solo-harness-review-2026-09-26.md`.

## Turning it on

A profile that setup creates runs solo: quick, full, blank-slate and local setup write
`agent.mode: solo` into it (full asks, with solo pre-filled). `trent setup --team` (or `--fleet`)
writes `agent.mode: fleet` instead: the fleet is the optional team. A profile that already has a
config keeps its mode: quick and blank-slate setup leave `agent.mode` as it is, full asks with the
profile's current runner pre-filled, and local setup writes solo unless `--team`. A profile without
the key runs the fleet, as every profile did before, so no existing profile changes runner
(`packages/trent-core/src/setup/solo-default.test.ts`). <!-- [C11.2] -->

| How | Scope |
|---|---|
| `agent.mode: solo` (or `fleet`) in `config.yaml` | every surface of this profile, until you change it back <!-- [C11.2] --> |
| `trent solo` | the REPL, for this launch |
| `trent --solo`, or `trent --team` (alias `--fleet`) for the fleet | the REPL, for this launch (`-c` and `--profile` work as usual) |
| `trent run --solo "<objective>"`, `trent run --team "<objective>"` | one run <!-- [C11.2] --> |
| `--solo` or `--team` on `trent cron run`, `trent cron start`, `trent gateway start`, `trent a2a serve`, `trent acp` | that process |

A launch flag beats `agent.mode`, which beats the default for a profile without the key, `fleet`.
The flag writes nothing: the next launch without it is back on `agent.mode`. `--solo` and `--team`
are global flags, so every command accepts them, and naming both is a usage error (exit 2); a pinned
cron job's child run gets the same flag. The commands not listed above (`trent service daemon`,
`trent heartbeat`, `trent jobs`, `trent goal`, `trent mcp serve`) follow `agent.mode`. The TUI
(`trent --tui`) runs the fleet only. `trent --dry-run` opens nothing and names the runner a launch
would start, by this precedence; with `--json` its document carries `launch`, `mode` and `firstRun`
(a first run reports solo, what setup would write; `apps/cli/src/commands/__tests__/team-mode.test.ts`). <!-- [C11.2] -->

The REPL's banner says which runner you are on: `solo · <model>` or `fleet · 9 seats`.
`trent run --json` and the `system` line of `--format stream-json` carry `"mode"`.

## Constrained output <!-- [C11] -->

On a local model (the `ollama` and `lmstudio` providers) every solo model call is decoded under a JSON
schema: the runtime sends the solo envelope as `response_format` (`solo/turn-settings.ts`, called from
`apps/cli/src/runtime/runner-for-mode.ts`), so the reply is either `{"tool_calls": [{"name", "arguments"}]}`
or `{"answer": "..."}`, with the conversation's tool names as an enum the server's grammar enforces
(Ollama `format`, llama.cpp `json_schema`, LM Studio). The same parser reads it back, so a call still
reaches the adapter, the idempotency key and the approval row as the `<tool> <json>` action it always
was. A hosted provider gets no schema and keeps the `<tool_call>` text protocol. The switch is the seats'
own, `models.local.constrained_output`: `false` turns it off for both, `all` also sends it to the hosted
providers that take a schema. A delegated child is constrained over its own tools; compaction's summary
calls never are. `agent.solo.max_tool_calls` (default 25, a whole number from 1 to 500, checked when the
config loads) is the most tool calls one run may make before it stops with a verdict naming the cap.
The prompt's own protocol (tag blocks, a plain-text answer) is impossible under that grammar, so the
system message of a constrained call ends with one paragraph naming the envelope; without it a 9B repeated
a read 26 times and never answered. The envelope is an `anyOf` of the two replies because Ollama did not
enforce the first form, a top-level `oneOf`.
`trent doctor` scores a local model on this format (`solo-format smoke N/5`, [doctor.md](doctor.md)), and
[local-models.md](local-models.md), "Solo on this machine", has what a real session measured.

## The conversation

In the REPL and in each gateway thread the conversation is that session's transcript
(`trent sessions`), and the solo runner is its only writer: every user line, every tool call, every
tool result and every answer is stored once, as the model saw it. `trent solo -c` continues the last
session with its tool results. A long conversation is compacted by the solo runner itself
(next section); the fleet's compactor, which is not safe for tool output, never touches it.

Each conversation has its own runner: a message in one chat thread never cancels or resumes a held
call in another. `trent run`, a cron job and a heartbeat are one-off conversations.

## Streaming <!-- [C13] -->

When the solo runner's gateway can stream, a turn reads the reply as the model writes it and emits the
answer's text as `step_delta` frames: only what the turn will show (the answer, or the words beside a tool
call), never the JSON envelope, a tool call or a `<think>` block
(`packages/trent-core/src/solo/stream-parse.ts`); `step_output` and `run_done` still carry the whole answer.
The REPL and `trent run --format text` print each line of the answer as soon as the model finishes it, and
the transcript is byte for byte the one an unstreamed turn leaves; `--format stream-json` carries the frames.
On the gateway, a solo turn keeps the chat's typing indicator on (every 4 s on Telegram, Discord, Signal and
WhatsApp) until the reply goes out, for a handler given its adapters' typing action. The runtime hands the runner a streaming gateway, and `trent gateway start` and the service
daemon pass the typing action (`apps/cli/src/runtime/runner-for-mode.cf.test.ts`,
`apps/cli/src/commands/__tests__/gateway-start.test.ts`); the REPL shows the text a completed line at a time.

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
the system prompt. The `memory` tool can add, replace and remove. In solo the agent is the only writer of its blocks: when a
fact changes ("I moved to York") it replaces the old entry in one call, it removes an entry you ask it to
forget, and it makes room in a full block in the same call. A read-only block (`company` by default) stays
read-only. The fleet is unchanged: a seat only adds, and entries are rewritten by the scheduled
consolidation. Every write carries provenance: after untrusted content anywhere in the conversation, a write
is held as an approval row, and approving an add writes the entry tagged with where it came from
(`[provenance: untrusted via web_extract]`; `packages/trent-core/src/tools/memory/owner.test.ts`).

The system prompt lists every installed skill by name and one line, never its body. `skill_view`
loads a skill; from then on its text rides every turn of the conversation, read fresh each turn, so it
survives a compaction and a restart.


## The system prompt

In order: the persona (`<profile>/brain/system/solo.md`, else the default), the solo rules, memory and the
brain as they stood when the session opened, the skills index, the tool protocol and the tools. The rules
are: use a tool rather than guess, and never claim a call that did not run. Make nothing up. Put independent
calls in one reply; they run one after another. Save durable facts about you, never a secret. Load a listed
skill before following it. A `solo.md` persona replaces only the persona; the rules stay. Over the default
tools the prompt is about 11,400 characters (about 2,850 tokens), and its own text and tool descriptions
name no seats and no founder (`packages/trent-core/src/solo/prompt-default.test.ts`).

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

## Cost: the fleet against solo, measured

Every figure is from a logged live run on this machine; the ledger charges whole cents per run, rounded up, so
"charged" and "list" differ on small runs (the bench reports list micro-cents for that reason, [bench.md](bench.md)).

| Model | Fleet (nine seats) | Solo |
|---|---|---|
| `gemini-3.5-flash-lite`, one small objective | 0.90 / 0.89 / 1.29 cents at list per run over three runs, charged 2 cents each (`docs/sessions/2026-09-25-p2-8-spend-truth.md`); the seats proof before the price fix used 36 provider calls in 27.9 s (`docs/sessions/2026-09-19-shippable.md`) | 0.28 cents at list for a three-turn session with a real tool call every turn, charged 3 cents (one per turn); 6,939 tokens in, 293 out; first token in 0.5 to 1.0 s (`docs/sessions/2026-09-26-c11-solo-live.md`) |
| `qwen3.5:9b` on this Mac (Ollama) | 0 of 2 steps in 600 s, the job timed out; 0 cents (`docs/sessions/2026-09-26-l0-3-setup.md`) | 3 of 3 turns, a completed tool call each; 33 to 40 s to a turn's first token under load, 3.6 to 6 s after a tool result; 0 cents; solo-format smoke 4 of 5 (`docs/sessions/2026-09-26-c11-solo-live.md`) |

Read it as: on a hosted model the fleet and solo cost the same order (about a cent), and solo's per-turn rounding
is what makes its charged figure larger than its list price; on the 9B only solo finishes.

## Limits

- The live proof is one three-turn session on `qwen3.5:9b` and one on `gemini-3.5-flash-lite`
  ([local-models.md](local-models.md), "Solo on this machine"); the fleet-against-solo cost table is still
  to come. <!-- [C11] -->
- `trent run --resume` resumes fleet runs only.
- A delegated fleet child is not metered against its parent's per-run cap (it is its own run on the
  ledger); its cents are added to the parent's turn as it reports them.
- Interrupted and failed turns carry no marker in the transcript yet (council A9).
- A parked run continued after a restart (`trent solo -c` then `/resume`) opens its conversation without
  the gateway platform, so that turn carries no platform hint.
