# 2026-09-20 — X2: the four binary findings from W1.1

Branch `feature/trent-fleet-v2`, base 841e36c. No commit made; files left in the working tree.
`TRENT_QUEUE_FALLBACK=disabled` exported in every shell. No live model was called; every binary run
was made from a scratch cwd (the repo root carries `.env.local`).

## Findings, root causes, fixes (each RED first)

1. **No binary was ever durable.** `store/createStore.ts` read `../../prisma/init.sql` off
   `import.meta.url`, which inside the compiled filesystem is `/prisma/init.sql` (ENOENT), so
   `openStore` fell back to `EphemeralStore`. Fix: `scripts/derive-sqlite-schema.mjs` writes the
   same DDL string to `src/store/derived-ddl.ts` (tracked, generated) next to `init.sql`;
   `readDerivedDdl()` returns that constant and never touches the disk; `build-binary.sh`
   refuses to build without the module. RED: `store/createStore.test.ts` (fs mocked to ENOENT)
   -> 2 failed, `readDerivedDdl` at createStore.ts:39. GREEN: 2 passed; the derive test gained a
   drift assertion.
2. **A cwd without `.claude/skills` killed the first seat step.** `apps/web/lib/agent-skill-instructions.ts`
   read granted skills from `process.cwd()` and let ENOENT escape. Deliberate app bug fix (invariant 1's
   exception; needs its own commit): a missing directory lists as `[]`, a granted skill whose
   `SKILL.md` is absent is skipped, an unknown skill still throws. Doctor-visible note: `check_skills`
   appends one sentence and `details.workspaceSkills`. RED: `apps/web/lib/agent-skill-instructions.test.ts`
   3 of 4 failed with ENOENT; `doctor/checks/skills.test.ts` 2 failed. GREEN: 4 and 2 passed.
3. **`--json` stdout carried `[Worker]` and pino lines.** `apps/web/lib/queue.ts:226` `console.log`s
   and `lib/logger.ts` (pino, debug level because Bun defaults NODE_ENV to development, straight to
   fd 1). Fix in `commands/groups/run.ts`: under `--json` or `--format stream-json`, for the run only,
   `console.log/info/debug` write to stderr and `LOG_LEVEL=silent` is set before the runtime is built
   (pino reads it once at module evaluation); both restored on release. RED: run.test.ts 2 failed
   (`expected undefined to be 'silent'`). GREEN: 22 passed.
4. **The binary autoloaded the cwd's `.env.local`.** Bun standalone executables load `.env*` from
   the launch directory by default; https://bun.sh/docs/bundler/executables documents
   `--no-compile-autoload-dotenv`. Fix: `scripts/ci/build-binary.sh` passes it (and
   `--no-compile-autoload-bunfig`). Proof: `scripts/ci/verify-binary.mjs` gained the scenario.

`scripts/ci/verify-binary.mjs` gained three checks (empty-cwd `run --json` with a durable
`trent.db` and `OrchestratorRun` table via `node:sqlite`; `.env.local` never reaching the
credentials check; the doctor's workspace-skills note), with credential-shaped env stripped.

## Evidence
- BEFORE (darwin-arm64 built from the tree before any change, scratch cwd, empty `TRENT_HOME`):
  `run "say hi" --json` exit 1, stdout 297 B (two `[Worker]` lines + result, `the run ended without
  a verdict`), stderr 0, no `trent.db`; with `.claude/skills` copied in: stdout 858 B with two pino
  lines; `doctor --json` in a cwd with `.env.local` `GEMINI_API_KEY=fake`: credentials check
  `keyLength: 4, shape: invalid` (and the embedder check probed Google with it).
- AFTER (`cd apps/cli && TRENT_DIST_DIR=<scratch> npm run build:binary -- darwin-arm64` exit 0):
  S1 empty cwd `run --json`: exit 1, stdout 231 B = one JSON object with
  `every model call failed: No model provider API keys...`, stderr 330 B (the `[Worker]` lines),
  `trent.db` 1.1 MB with 71 tables incl. `OrchestratorRun`, `Approval`, `Company`.
  S2 cwd with skills: exit 1, stdout 231 B, stderr 330 B, no pino line anywhere.
  S3 `.env.local` fake key, `doctor --json`: exit 3, stderr 0, credentials
  `needs GEMINI_API_KEY; the secrets file does not exist yet`, embedder `skip`.
  S4 `doctor --json` after S1: exit 3, stderr 0, Skills Hub carries the workspace note, Database
  `integrity_check ok, journal_mode wal`.
- `node scripts/ci/verify-binary.mjs`: BEFORE binary exit 1 (the three new checks FAIL for the
  three reasons above), AFTER binary exit 0, 9 PASS.
- Clean worktree of HEAD + exactly these files: `npx tsc --noEmit -p apps/cli/tsconfig.json` 0;
  `npm --prefix packages/trent-core run build` 0; `node scripts/ci/repo-scan.mjs` 0;
  `npx vitest run packages/trent-core/src/store packages/trent-core/src/skills
  packages/trent-core/src/telemetry apps/cli/src/commands/__tests__/run.test.ts
  apps/cli/src/commands/__tests__/registry.test.ts packages/trent-core/src/wrapped-modules.test.ts
  packages/trent-core/src/doctor/checks/skills.test.ts` 0 (17 files, 797 tests);
  `packages/trent-core/src/doctor apps/cli/src/runtime` 0 (25 files, 168 tests);
  `cd apps/web && npx vitest run lib/agent-skill-instructions.test.ts lib/agent-skills.test.ts
  lib/company-skill-instructions.test.ts --pool=forks --poolOptions.forks.singleFork=true` 0
  (3 files, 28 tests); `cd apps/web && npx tsc --noEmit` 0 errors.
- In the SHARED tree `tsc -p apps/cli` exits 2 on other agents' untracked files
  (`orchestrator/auto-recovery.ts`, `__tests__/cron-queue.test.ts`); none of the errors is in a
  file this task touched.

## Not done / notes
- Running from SOURCE (`bun apps/cli/src/index.ts`) still autoloads the cwd's `.env*`; documented
  (`bun --no-env-file`). The linux-x64 binary was not rebuilt or run here (no container in this task).
- `docs/tools.md` in the shared tree is another agent's edit.
