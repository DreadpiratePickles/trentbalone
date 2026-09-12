# Stage: 04_verification

## Objective
Independently prove or disprove every completion claim. Assume failure until evidence says otherwise.

## Inputs
| Path or source | Layer | Authority | Required |
|---|---:|---|---:|
| `03_implementation/output/task-log.md` | 4 | Claim under test | Yes |
| Master Prompt anti-pattern checklist + completion criteria | 3 | Governing | Yes |
| `01_discovery/output/baseline-report.md` | 4 | Baseline | Yes |

## Process
1. Re-run every claim from a clean shell. A claim without a reproducible command is unproven.
2. Run the 16-item anti-pattern checklist (the 15 from the prompt, plus **"what survives a process
   restart?"**, added after review).
3. Adversarial probes, not happy paths: kill the process mid-run; unset the API key; corrupt the config;
   run two instances; disconnect the network; fill the disk.
4. Verify the binary by **running** it on each target OS. A successful compile is not evidence.
5. Confirm no secret appears in any artifact, log or commit.

## Outputs
| Path | Format | Consumer |
|---|---|---|
| `output/verification-report.md` | markdown: claim, command, exit code, verdict | 05_release |
| `output/anti-pattern-checklist.md` | markdown, 16 items, each pass/fail with evidence | user |

## Verify
Every row carries a command and an exit code. Any unproven row is reported as unproven, never omitted.

## Approval
The verifier is not the author. Release is blocked while any checklist item fails.

## Failure Behavior
A failed item returns to 03_implementation with the reproducing command. Never weaken the check.
An item that cannot be tested on this machine (for example a Linux binary) is marked
`untested-on-this-platform` and moved to CI, never marked pass.
