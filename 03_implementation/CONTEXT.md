# Stage: 03_implementation

## Objective
Execute the approved plan one task at a time under strict test-first discipline, producing working code
that imports the real platform.

## Inputs
| Path or source | Layer | Authority | Required |
|---|---:|---|---:|
| `02_plan/output/implementation-plan.md` | 4 | Contract | Yes |
| `02_plan/output/design-doc.md` | 4 | Contract | Yes |
| `01_discovery/output/*-contract.md` | 4 | Reference | Yes |
| `AGENTS.md` | 0 | Invariants | Yes |

## Process
Per task, in this order, no shortcuts:
1. **RED** — write the failing test. Run it. Confirm it fails **for the expected reason**, not by accident.
2. **GREEN** — the minimum code that passes. No extra features. YAGNI.
3. Run the task's verification commands. Record exit codes.
4. **REFACTOR** — improve without changing behaviour. Re-run.
5. **REVIEW** — two stages: does it match the plan, and does it obey the coding rules.
   CRITICAL findings block the next task.
6. Commit with explicit file paths and a message naming the hypothesis.

Delete code written before its test. Never weaken a test to make code pass. Never mock the thing under test.

## Outputs
| Path | Format | Consumer |
|---|---|---|
| `packages/trent-core/src/**` | TypeScript ESM | apps/cli, apps/desktop |
| `apps/cli/src/**` | TypeScript ESM | users |
| `output/task-log.md` | markdown: task, test, commands, exit codes, commit sha | 04_verification |

## Verify
- `cd apps/web && npm test` exits 0 after every task (the app must never regress).
- The new package's own tests pass.
- `npm run typecheck` exits 0.
- No file exceeds 500 lines.
- `grep -rniE "canned|simulate|placeholder|not implemented|TODO|FIXME" packages/trent-core/src apps/cli/src`
  returns nothing outside tests.

## Approval
Orchestrator plus a reviewer that did not write the code. No user gate per task.
No push, no publish, no deploy.

## Failure Behavior
A test passes on the first run: the test is wrong; fix the test before the code.
A wrapper cannot import a `lib/` module: fix the wrapper, never `apps/web`.
Three failed attempts at one task: stop, write down what was learned, and re-plan the task.
