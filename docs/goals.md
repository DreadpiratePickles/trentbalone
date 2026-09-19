# Goals, quality gates and verify_on_stop

Evidence before judgment. A goal is a standing objective that outlives one run, with a completion
contract and **deterministic shell quality gates** that must exit 0 before any model judge is
consulted. A red gate ends the run *gated* — not failed, not completed — and its own output becomes
the prompt the next run starts from. Separately, `verify_on_stop` refuses a final answer on any turn
that edited code and can show no fresh evidence that something passed afterwards.

Both exist because a model asked "is this done?" over a red build will sometimes say yes.

## A gate is an argv, never a command line

```yaml
goals:
  verify_on_stop: true
  verify_commands: ["npm test", "npm run typecheck", "npx vitest", "npx tsc", "pytest", "go test", "cargo test"]
  auto_continue: false
  max_continuations: 3
```

A gate is an executable plus an argument array. It comes from your config or from `--gate` on the
command line, it is quoted element by element, and it runs through the **same sandbox the `terminal`
toolset runs in** — the Docker sandbox with the workspace bind-mounted and no network, or the
confined local backend. Nothing a model produced is ever spliced into a shell. That is the whole
safety property: a gate the agent could rewrite would not be a gate.

## Opening a goal

```bash
trent goal create "Ship the parser" --gate "typecheck=npx tsc --noEmit" --gate "tests=npm test"
trent goal list
trent goal show goal_1a2b3c4d5e6f
trent goal continue goal_1a2b3c4d5e6f
```

In the REPL:

```
/goal Ship the parser --gate "typecheck=npx tsc --noEmit"
/goals
/goal continue goal_1a2b3c4d5e6f
```

A goal lives in one file under the profile:

```
<profile>/goals/                     0700
<profile>/goals/<id>.json            0600, written temp-then-rename
```

The record holds the objective, the completion contract, the gates, the status (`open`, `gated`,
`completed`, `abandoned`), when it was created, every run of it, and how many continuations have
been started.

## What happens at the end of a run

1. **The gates run, in order.** The first red one stops the rest: the run is over already, and the
   remaining gates would cost minutes and buy nothing.
2. **A red gate ends the run `gated`.** The gate's name, its exit code and a bounded tail of its
   output (4 kB, head and tail, so a compiler's first error and a runner's verdict both survive) are
   written into the goal's history. The judge is **not** consulted.
3. **`verify_on_stop` applies**, goal or no goal.
4. **Only then is the judge asked** whether the contract is met. With no judge configured for the
   profile, the gates are the whole verdict — which is honest, and better than a judge that cannot
   see a build.

The reason for anything other than a clean finish rides the run's event stream as a `step_note`, so
every surface that renders events prints it without a change of its own.

## Continuations

A gated goal is owed another attempt. The red gate's report is the history the next run works from,
so the model starts by reading the exact failure rather than being told to try again.

`trent goal continue <id>` starts that attempt on the same headless runtime `trent run`, the
gateway and the cron runner use. With `goals.auto_continue: true` it happens without being asked.
Either way `goals.max_continuations` (default 3) bounds it: a continuation is a whole metered run,
so the cap is a spend bound as much as a patience bound. Past the cap the goal stops and says so.

## verify_on_stop

> This turn edited `src/parser.ts` and nothing verified the result afterwards, so the answer is not
> final. Run one of `npm test`, `npm run typecheck`, … and let it exit 0, then ask again.

The rule is one sentence: **if the checkpoint ledger says this turn wrote files, the turn does not
end with an answer unless a verification command exited 0 after the last of those writes.**

- The writes come from the ledger that already records them (`docs/checkpoints.md`), not from a
  second record. A `rollback` row is an undo, not an agent write, so a turn that only rolled back
  has edited nothing.
- Evidence is a `terminal` or `code` tool call whose command matches `goals.verify_commands`, or a
  goal's own gate. Matching is on the executable (by basename, so `/usr/local/bin/npm` is `npm`) and
  every word the configured entry names: `npm test` matches `npm test -- -t parser`, and
  `npm run typecheck` does not match `npm run build`, because building is not verifying.
- **Order is the whole point.** A green test run from *before* the last write proves something about
  bytes that no longer exist, so it does not count.
- A green gate counts whatever its argv is: the profile named it as what must pass, which is a
  stronger statement than `verify_commands` makes.
- A turn that wrote nothing is untouched. `goals.verify_on_stop: false` turns the rule off for the
  profile — a decision a profile can make, and one an agent cannot make for itself.

The exit code a tool call implies is read off the terminal toolset's own reporting contract: a
`ToolCallRecord` carries a status and a summary and no exit code, so a non-zero command is
`completed` with an `[exit code N]` note and a timeout is `failed` with `[timed out …]`.

## Where it is wired

| Piece | File |
|---|---|
| Goal record, store, gates, continuations | `packages/trent-core/src/goals/` |
| The `goals` config block | `packages/trent-core/src/goals/config-schema.ts` |
| The evidence ledger and the tool-call watcher | `packages/trent-core/src/goals/evidence.ts` |
| The run-end hook | `packages/trent-core/src/orchestrator/run-verification.ts` |
| The session every surface shares | `apps/cli/src/runtime/goals.ts` |
| `/goal`, `/goals` | `apps/cli/src/repl/goal-commands.ts` |
| `trent goal …` | `apps/cli/src/commands/groups/goal.ts` |

The goal session is opened once, in the graph every surface is built on, so `trent run`, the
gateway, cron and the heartbeat all get gates and `verify_on_stop` with no wiring of their own —
exactly as `/rollback` finds the checkpoint ledger.
