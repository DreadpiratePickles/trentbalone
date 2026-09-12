# Stage: 02_plan

## Objective
Turn discovery evidence into one approved design and a task list an inexperienced engineer could execute
without judgment.

## Inputs
| Path or source | Layer | Authority | Required |
|---|---:|---|---:|
| `01_discovery/output/*` | 4 | Evidence | Yes |
| `~/Downloads/Trent Fleet Master Prompt v2.md` | 3 | Governing | Yes |
| `~/Downloads/Trent Fleet Implementation Plan v2.md` | 3 | Governing | Yes |
| `02_plan/output/design-review-*.md` | 4 | Verifier | Yes, once written |

## Process
1. Propose 2-3 approaches per major decision, with trade-offs and a recommendation. Never one option.
2. Present the design to the user in digestible sections. **Hard gate: no code until approved.**
3. Submit the design to an independent reviewer. The author never grades the design.
4. Resolve every CRITICAL finding, or record why it is deferred, before implementation.
5. Decompose into tasks of 2-5 minutes each. Every task carries exact file paths, complete interfaces,
   the failing test and its expected failure message, ordered steps, and verification commands.

## Outputs
| Path | Format | Consumer |
|---|---|---|
| `output/design-doc.md` | markdown | 03_implementation |
| `output/design-review-v*.md` | markdown, findings ranked CRITICAL/MAJOR/MINOR | design author |
| `output/implementation-plan.md` | markdown, numbered tasks | 03_implementation |
| `output/baseline.txt` | plain text sha | 03_implementation |

## Verify
- The design names every wrapped `lib/` file and the count is >= 8.
- The design uses tokens from `design-tokens.json` and no invented colour.
- Every CRITICAL review finding maps to a design change or a written deferral.
- Every plan task names a test to write first and the failure it expects.

## Approval
**User approves the design. This is a hard gate.** The reviewer approves the resolution of CRITICALs.

## Failure Behavior
Review rejects the design: revise and re-review; do not proceed on the author's own judgment.
A decision that rests on an untested assumption: spike it before approval, not during implementation.
