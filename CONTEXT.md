# CONTEXT.md — workspace routing (ICM Layer 1)

> Where do I go? Read `AGENTS.md` first for identity and invariants.

## Task routing
| If the task is… | Go to | Read first |
|---|---|---|
| Understanding the existing app before changing anything | `01_discovery/` | `01_discovery/CONTEXT.md` |
| Choosing an approach, or revising the design | `02_plan/` | `02_plan/CONTEXT.md` |
| Writing code for an approved plan task | `03_implementation/` | `03_implementation/CONTEXT.md` |
| Proving a claim with commands and exit codes | `04_verification/` | `04_verification/CONTEXT.md` |
| Packaging, installers, hosting, publishing | `05_release/` | `05_release/CONTEXT.md` |

## Stage flow and gates
```
00 discovery ──▶ 01 design ──▶ 02 branch ──▶ 03 implementation ──▶ 04 verification ──▶ 05 release
   evidence      USER GATE     baseline       TDD, one task at a time    independent      USER GATE
                                              REVIEW GATE per task        verifier
```
Two gates need a human: design approval, and anything that leaves this machine
(push, publish, DNS, deploy). Every other gate is evidence-based and blocks on a failing check.

## Shared resources — the authoritative answer to common questions
| Question | Authority |
|---|---|
| What colour is anything? | `01_discovery/output/design-tokens.json`, `01_discovery/output/style-contract.md` |
| Can the CLI import this `lib/` module? | `01_discovery/output/lib-wrapping-matrix.md`, `01_discovery/output/codebase-audit.json` |
| How do I stream real model output? | `01_discovery/output/model-gateway-contract.md` |
| How do I run the agent pipeline? | `01_discovery/output/orchestrator-contract.md` |
| Which env vars must be set? | `AGENTS.md`, "standalone environment contract" |
| Can I ship X in the binary? | `01_discovery/output/distribution-feasibility.md`, `spike-prisma-results.md`, `spike-serve-results.md` |
| What does the baseline actually pass? | `01_discovery/output/baseline-report.md` |
| What is the current design? | `02_plan/output/design-doc.md` |
| What was wrong with the last design? | `02_plan/output/design-review-v1.md` |
| What is the task list? | `02_plan/output/implementation-plan.md` |
| What did the previous agent get wrong? | `docs/sessions/2026-09-12-antigravity-audit.md` |

## Layer discipline
- **Layer 3, `references/`** — stable rules that outlive a task. Copy nothing here that changes weekly.
- **Layer 4, `output/`** — working artifacts, dated, regenerable.
- Never bulk-load the repository. Load the minimum sufficient context for the stage you are in.

## Session log
Append to `docs/sessions/YYYY-MM-DD-<topic>.md` **during** the session, not at the end.
When context runs long, write the log first and recontextualize from the log plus these files —
never from chat memory.
