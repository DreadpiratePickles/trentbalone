# 2026-09-19 — Shippable goal: prove Trent is ready for its first release

Goal (Bobby's /goal prompt, recorded in `docs/sessions/2026-09-18-hermes-parity-assessment.md`
"Queued"): every done-criterion holds on a detached worktree of HEAD with raw output shown.
Start: HEAD 10f1f19, wave 3 closed (clean-HEAD suite 2853 passed / 1 skipped).

## Steps
- Baseline on HEAD 10f1f19 (clean worktree): `npx vitest run --reporter=dot` exit 0, 287 files,
  2853 passed / 1 skipped; tsc 0; core build 0; repo-scan 0 (`scratchpad/iso-wave-close.log`).
- TODO/FIXME in core+cli src outside tests today: 24 (`grep -rn "TODO\|FIXME" ... | grep -v .test.ts`).
- `cd apps/cli && npm run build:binary` exit 0: trent-darwin-arm64, darwin-x64, linux-x64,
  windows-x64.exe in dist/. `TRENT_HOME=$(mktemp -d) dist/trent-darwin-arm64 doctor --json` exit 3
  (documented: exit 3 on a configuration failure), 18 checks, 9 pass / 4 warn / 1 fail (API
  credentials: no key in an empty home) / 4 skipped.
- The ci.yml lint job is: derive-sqlite-schema.mjs, prisma generate (both schemas), then
  `npx tsc --noEmit -p apps/cli/tsconfig.json` (apps/web has no ESLint config by design; its gate
  is its suite and typecheck). Same commands as the typecheck criterion; counted once.
- Agents launched: G1 (W3.1 wiring), G2 (interrupted fragments on recall/app memory), G3 (spend
  ledger), G4 (docs truth + test), G7 (golden-capture determinism).
- G8: the 24 raw TODO/FIXME hits are the todo tool's constants (`TODO_STATUSES` etc.); the
  comment-anchored grep `grep -rnE '(//|/\*|\*)[[:space:]]*(TODO|FIXME)\b' ...` returns 0; no
  marker has ever existed (git log -S). Registered in AGENTS.md. Criterion met on the honest form.
- G4 done (docs-truth test, 11 assertions from code; README/getting-started/configuration/security/
  doctor corrected: 18 doctor checks, 32 commands / 126 subcommands, thirteen toolsets with nine on
  by default, all new keys documented). HELD until G1 (approvals) and G3 (budget) land because the
  count assertion reads the registry.
- G3 landed (spend ledger). Follow-up G3.1: installSpendLedger + surface tag at surface start-up. Isolation now runs vitest with --maxWorkers=4; the first G3 run failed on a mis-cut index line and load timeouts (load avg 650).
- G1 landed (traceSink wired, trent approvals for held writes, scan key honoured; headless-wiring.ts extracted).
- G4 landed (docs truth test + four docs corrected).
- G7 landed (golden-capture boots outside the timed hook; root cause was module import time under
  load, not retries). G2 landed (interrupted fragments excluded from recall and app memory). G3.1
  landed (spend ledger installed per surface with surface tags). All goal agents done.
- Final clean-HEAD (fbb06ce) run: `npx vitest run --reporter=dot` exit 0, 297 files, 2969 passed /
  1 skipped; tsc 0; core build 0; repo-scan 0. JSON report names the skip:
  `apps/cli/src/commands/__tests__/web.test.ts :: trent web --start against the real standalone
  build` (needs `.next/standalone`; building it now to remove the skip).
- `cd apps/web && npm test`: 514 files, 2825 passed / 125 skipped, exit 0; `npm run typecheck` 0.
- Lint job commands (derive-sqlite-schema, prisma generate x2, tsc apps/cli): all exit 0.
- `node --test` pages gate suites: FAIL "pages.yml has no gate job" until the held workflow patch
  is applied (blocked on the workflow scope of the DreadpiratePickles token). render check 0.
- Comment-anchored TODO/FIXME grep: 0. Tree clean.
- Live proofs on the key: conversation 6/6 (13.5 s), seats 5/5 (12 cents, 27.9 s, 36 provider
  calls, finance:completed analyst:completed), embedder 1/1 (cos paraphrase 0.754 vs 0.529).
- CI: every run since 03:11 fails in seconds with "The job was not started because recent account
  payments have failed or your spending limit needs to be increased" (GitHub Actions billing);
  last green run 35417800846 on bdaab39. Bobby-only.
- Standalone tree built with `node apps/desktop/scripts/prepare-resources.mjs` (exit 0); the one
  skipped test now runs: `web.test.ts` 10 passed / 0 skipped. Core+CLI suite therefore has zero
  skips on this machine (Docker daemon up, standalone tree present, live tests gated by config).
- Workflow patch applied and pushed after the scope refresh; node --test gate suites 15 passed.
- Workflow patch committed and pushed after the scope refresh; gate suites exit 0.

## Outcome
Every done-criterion holds locally on a clean checkout of HEAD except CI, which GitHub refuses to
start on this account ("recent account payments have failed or your spending limit needs to be
increased"; every run since 35417850217 on 2026-09-19 03:11 UTC; last green 35417800846 on
bdaab39). Bobby-only. Re-run after billing: `gh run rerun <id>` or any push.
- Repo made public on Bobby's instruction after a full-history secret scan (all hits were test
  fixtures, scanner patterns or vendored doc placeholders; gem.env never committed). CI re-run
  35422933787 triggered.
