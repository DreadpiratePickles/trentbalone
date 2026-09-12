# Stage: 01_discovery

## Objective
Establish, with executable evidence, what the existing Trent application already does and what a new
surface may safely assume — before any design is proposed.

## Inputs
| Path or source | Layer | Authority | Required | Relevant section |
|---|---:|---|---:|---|
| `apps/web/CLAUDE.md`, `apps/web/AGENTS.md` | 3 | Source of truth | Yes | rules, security invariants |
| `apps/web/brand/DESIGN_PROMPT.md`, `app/styles/base.css` | 3 | Source of truth | Yes | colour grammar, tokens |
| `apps/web/lib/*.ts` (14 named modules) | 4 | Source | Yes | exports, runtime deps |
| `apps/web/prisma/schema.prisma` | 4 | Source | Yes | models, provider |
| `~/Downloads/Trent Fleet *v2.md` | 3 | Governing | Yes | all |

## Process
1. Read the repo's own instruction files before anything else. They outrank the spec documents.
2. Extract every CSS custom property; map to named tokens. Deterministic — no judgment.
3. For each `lib/` module, record exports verbatim and classify CLI-importability.
4. Establish the baseline: build and test the untouched app; record commit and exit codes.
5. Falsify, do not assume. Any claim that changes the architecture gets a spike that can disprove it.
6. Record facts, assumptions, unknowns and contradictions separately.

## Outputs
| Path | Schema or format | Consumer |
|---|---|---|
| `output/codebase-audit.json` | JSON, 14 modules with exports and deps | 02_plan, 03_implementation |
| `output/design-tokens.json` | JSON, colour/type/space tokens | every UI task |
| `output/baseline-commit.txt` | plain text sha | 02_plan |
| `output/baseline-report.md` | markdown, commands + exit codes | 04_verification |
| `output/{model-gateway,orchestrator}-contract.md` | markdown, wrapping contracts | 03_implementation |
| `output/lib-wrapping-matrix.md` | markdown table | 03_implementation |
| `output/style-contract.md` | markdown, ANSI + motif mapping | CLI/TUI/desktop tasks |
| `output/spike-*.md` | markdown, verdict + evidence | 02_plan |

## Verify
- `cd apps/web && npx next build` exits 0.
- `cd apps/web && npm test` exits 0.
- `codebase-audit.json` parses and lists >= 12 modules.
- `design-tokens.json` contains obsidian, ink, steel, pulse, ember.
- Every spike states VERIFIED or FALSIFIED with the command that produced it.

## Approval
Orchestrator verifies. No user gate. No external action permitted in this stage.

## Failure Behavior
Build failure: fix the environment, do not proceed, do not modify `apps/web`. Tokens unreadable: fetch
from the GitHub raw URL. Pre-existing test failures: document as pre-existing, do not block, do not fix.
A spike that cannot be run is reported as `unverified`, never as verified.
