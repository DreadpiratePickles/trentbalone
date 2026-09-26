# 2026-09-26 — C9: a keyless first run finds the model already on the machine

Agent C9 (Opus), council item C9 of `02_plan/output/hermes-council-verdict-2026-09-26.md`.
Branch `feature/trent-fleet-v2`, started at HEAD `0d73850`, now `9fee7d2` (two egress/browser commits by
other agents; none touches a C9 file). No commit, stash, checkout, reset or push; no subagents; no
real model and no real Ollama in tests; single test files only (load averages 120-240).

## Brief
With no provider key and a local runtime on loopback that `trent setup --mode local` could use right
now, `trent setup --json` (quick, no key) exits 3 with `reason: "no-key"`, `suggested: "local"` and the
line `trent setup --mode local` in its message; bare `trent` prints that command as its first
suggestion; `trent doctor`'s credentials hint and the degraded REPL banner name it too. With no local
runtime reachable, every message and exit code stays exactly as it is.

## Read first
AGENTS.md; rulebook "Universal Coding Rules" and Phase 4; council C9; docs/local-models.md; the L2 log.
Code: `setup/{QuickSetup,detect,local-detect,local-plan,LocalModeSetup,SetupRun,SetupWizard,types}.ts`,
`doctor/checks/credentials.ts`, `apps/cli/src/repl/degraded.ts`, `apps/cli/src/commands/index.ts`
(first run), `apps/cli/src/commands/groups/diagnostics.ts` (`runSetup`), and the tests that exercise a
keyless quick run (`SetupWizard.test.ts`, `behaviour.test.ts`, `boot.test.ts`, `degraded.test.ts`,
`credentials.test.ts`, `setup-local.test.ts`).

## Facts checked before code
- Ollama 0.32.9 answers on 127.0.0.1:11434 on this Mac (`curl /api/version` exit 0).
- "Would `setup --mode local` work right now" is already computed by L2: `local-detect.ts`
  (`createLocalDiscovery().detect`) then `local-plan.ts` `chooseRuntime` + `chooseChat` with
  `pull: false`. `chooseChat` never picks a cloud model or one its runtime lists without `tools`. C9
  reuses exactly that pair; it adds no second detector and no second fitness rule.
- `diagnostics.ts` `runSetup` copies the wizard result field by field (mode, success, message, reason,
  secretsConfigured, local), and `SetupResult` (`setup/types.ts`) has no field for a suggestion. So
  `suggested` cannot reach `setup --json` without one line in each of those two files, which are NOT
  in the brief's edit list. Neither carries an `[L1]/[H5]/[P3]/[S3]` marker and both are clean in the
  tree. Decision: one `// [C9]` hunk in each, reported to the lead as outside the list, with the reason.
- `repl/index.ts` (carries `[S3]`, off limits) calls `degradedState({ source, provider, model })` and
  hands `notice` to the engine, which renders it in place of the no-key paragraph. So the banner can
  change only through `degradedState`'s `notice`, with the default (real) discovery, no call-site edit.
- Existing tests that run a keyless quick setup or a keyless degraded state through the DEFAULT
  discovery would, on a machine running Ollama (this one), now probe it and see the new text:
  `SetupWizard.test.ts` (3 no-key cases), `behaviour.test.ts` "the real wizard on a profile with no
  provider key" (asserts `Setup did not complete: No provider key found.`), `boot.test.ts` first launch,
  `degraded.test.ts` "a hosted provider keeps the key rule", `credentials.test.ts` "no key at all".
  Each asserts the NO-runtime behaviour, so each gets its precondition stated (a discovery that finds
  nothing, or the two base URLs at closed port 9, L2's convention), marked `// [C9]`; no assertion is
  loosened.

## Log
### Baseline (before any change; single files, `TRENT_QUEUE_FALLBACK=disabled npx vitest run <files>`)
- `setup/SetupWizard.test.ts` + `doctor/checks/credentials.test.ts` -> exit 0, 32 tests.
- `repl/__tests__/degraded.test.ts` + `repl/__tests__/boot.test.ts` -> exit 0, 23 tests.
- `commands/__tests__/behaviour.test.ts` + `commands/__tests__/setup-local.test.ts` -> exit 0, 43 tests.

### RED 1 and 4: `setup --json` and bare `trent` (new `apps/cli/src/commands/__tests__/setup-keyless.test.ts`)
A real `node:http` server on 127.0.0.1 plays Ollama (L2's `fakeLocal` behind it), found via
OLLAMA_BASE_URL; LMSTUDIO_BASE_URL at closed port 9; every provider key variable stubbed empty; fresh
TRENT_HOME. Four cases: usable model -> suggestion (red), no runtime -> today's exact message (guard),
only a no-tools chat model plus a cloud model -> no suggestion (guard), bare `trent` first run (red).
`npx vitest run apps/cli/src/commands/__tests__/setup-keyless.test.ts` -> **exit 1**, 2 failed, 2 passed:
- (1) `expected undefined to be 'local'` on `doc.suggested` (exit 3 and `reason: no-key` already held).
- (4) `expected -1 to be 671`: the first `trent setup` on the first-run screen (offset 671) is detect.ts's
  `trent setup --mode quick --provider ollama`; `trent setup --mode local` appears nowhere.

### RED 2: the doctor's credentials hint (`doctor/checks/credentials.test.ts`)
New case: provider anthropic, no key, `env: {}`, `fetchImpl` = L2's in-process `fakeLocal` Ollama at
its default origin listing `qwen3.5:9b` with `tools`. The existing "no key at all" case now states its
precondition (`fetchImpl` refusing every origin, `env: {}`) and asserts today's hint EXACTLY (was only
`toBeTruthy`), so the no-runtime text is pinned, not loosened.
`npx vitest run packages/trent-core/src/doctor/checks/credentials.test.ts` -> **exit 1**, 1 failed, 9 passed:
`expected 'Run \`trent config set ANTHROPIC_API_K…' to match /^Run \`trent setup --mode local\`/`.

### RED 3: the degraded banner (`apps/cli/src/repl/__tests__/degraded.test.ts`)
New case: `degradedState` for a keyless `openai` profile with a `discovery` over the same fake. The
existing "a hosted provider keeps the key rule and never probes a runtime" case gets a discovery that
finds nothing (its L0-3 runtime spy is still asserted unprobed).
`npx vitest run apps/cli/src/repl/__tests__/degraded.test.ts` -> **exit 1**, 1 failed, 20 passed:
`expected '◆ DEGRADED MODE — no model provider k…' to contain 'Ollama at http://127.0.0.1:11434 has …'`.

### GREEN (implementation)
- `setup/detect.ts`: `LOCAL_SETUP_COMMAND`, `KeylessLocal`, `findKeylessLocal({ env, discovery?,
  totalMemoryBytes? })` = L2's `detect` -> `chooseRuntime(probes, {})` -> `chooseChat(runtime, { pull:
  false })`, i.e. "what `trent setup --mode local` would pick now"; `describeKeylessLocal`;
  `missingKeyGuidance(configManager, local?)` leads with the model and the command when `local` is
  given and is byte-identical to today's otherwise (its last line, `--mode quick --provider ollama`,
  is kept only then).
- `setup/QuickSetup.ts`: no key and no `--provider` -> `findKeylessLocal` (the context's
  `localDiscovery` and memory); with a result the stop message names it and `Run: trent setup --mode
  local`, and the result carries `suggested: "local"`. Reason and exit are unchanged (`no-key`, 3).
- `setup/types.ts` (OUTSIDE the brief's list, 1 field): `SetupResult.suggested?: "local"`.
- `apps/cli/src/commands/groups/diagnostics.ts` (OUTSIDE the list, 2 lines): `runSetup` passes
  `suggested` through, so `setup --json` and the first run's `--json` document carry it.
- `apps/cli/src/commands/index.ts`: NO change needed. The first-run screen prints the wizard's guidance
  (now leading with the command) and then `Setup did not complete: <message>` (now naming it).
- `doctor/checks/credentials.ts`: no key -> `findKeylessLocal` through the doctor's `fetchImpl`, `env`
  and probe deadline; hint `Run \`trent setup --mode local\` to use <model> on <runtime> at <url>, which
  needs no key; or \`trent config set <VAR> <your-api-key>\`.`, `details.suggested: "local"`.
  Message and status unchanged.
- `apps/cli/src/repl/degraded.ts`: a keyless hosted profile probes (default discovery; injectable
  `discovery`) and, with a result, returns the no-key paragraph as `notice` with its fix sentence
  replaced by `<runtime> at <url> has <model>, which needs no key. To use it, run: trent setup --mode
  local — or put a provider key ...`. PARAGRAPH split into head + key fix; its text is unchanged.
- Green runs: setup-keyless.test.ts exit 0 (4); credentials.test.ts exit 0 (10); degraded.test.ts exit 0 (21).

### Existing tests given their no-runtime precondition (no assertion loosened)
- `SetupWizard.test.ts`: `wizardWith` and the no-terminal case inject a discovery that refuses every origin.
- `behaviour.test.ts` "the real wizard on a profile with no provider key": both base URLs at port 9.
- `boot.test.ts`: both base URLs at port 9 for the whole file. Found the hard way: with them unset,
  "Ctrl+C at 100ms exits 130" timed out at 20 s (exit 1) because the keyless banner's probe of this
  Mac's real Ollama ran before the boot attached its key listener, so the 100 ms Ctrl+C went to no one.
  With the closed port the refusal is immediate: `boot.test.ts` exit 0, 3 tests.
- Not edited, checked: `continue`, `writer-lock`, `solo.repl` start a keyless hosted REPL and now probe;
  none asserts the banner; with both URLs at port 9 in the shell -> exit 0, 7 tests. On a machine where
  Ollama answers they ask it for its model list (GET) and their banner names the model; nothing else.
  `solo-continuity.repl.test.ts` (S3's, untracked) is the same shape and was not run or touched.
  `doctor/DoctorRunner.test.ts` "registers every check" runs the credentials check keyless with the real
  fetch at a 150 ms deadline: same effect, no assertion on the hint. Not edited (outside the list).

### VERIFY (repo root, `TRENT_QUEUE_FALLBACK=disabled`, one file or one small directory per run)
- `npx vitest run apps/cli/src/commands/__tests__/setup-keyless.test.ts apps/cli/src/commands/__tests__/setup-local.test.ts` -> exit 0, 9 tests.
- `npx vitest run packages/trent-core/src/setup` -> exit 0, 4 files, 56 tests.
- `npx vitest run packages/trent-core/src/doctor/checks/credentials.test.ts apps/cli/src/repl/__tests__/degraded.test.ts` -> exit 0, 31 tests.
- `npx vitest run apps/cli/src/commands/__tests__/behaviour.test.ts` -> 38 passed; `apps/cli/src/repl/__tests__/boot.test.ts` -> exit 0, 3 tests (after the file-level precondition above).
- `npx vitest run apps/cli/src/commands/__tests__/docs-truth.test.ts` -> exit 0, 12 tests (section 7's transcript is the no-runtime case, unchanged).
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0. `cd packages/trent-core && npm run build` -> exit 0.
  `node scripts/ci/repo-scan.mjs` -> exit 0. Largest touched file: `SetupWizard.test.ts` 456 lines.
- Every hunk in the 11 edited files carries `[C9]` (checked per hunk with `git diff | awk`).

### LIVE (this Mac: M1 Max 32 GB, Ollama 0.32.9 idle, no `*_API_KEY` in the shell; load 22-120)
- `TRENT_HOME=<scratch> npm run --silent cli -- setup --json` -> **exit 3**; stdout:
  `{"mode":"quick","success":false,"message":"No provider key found, but Ollama at http://127.0.0.1:11434
  has qwen3.5:9b, which needs no key. Run: trent setup --mode local (or set OPENAI_API_KEY or another
  provider variable listed above in your environment or in <home>/.env, then run setup again).",
  "reason":"no-key","secretsConfigured":[],"suggested":"local"}`. stderr leads with the same command.
  `qwen3.5:9b` because the 32 GB tier's `qwen3.6:27b` is not pulled (L2's fallback). Only
  `HEARTBEAT.md` written, as before.
- Bare `npm run --silent cli < /dev/null` on a fresh home -> exit 0: the first screen's second line is
  `Ollama at http://127.0.0.1:11434 has qwen3.5:9b. To use it, run: trent setup --mode local`, and the
  DEGRADED MODE banner names the model and the command before the key sentence (council "Proof").
- `npm run --silent cli -- doctor --json` on a fresh home -> exit 3 (failed checks, as before); API
  Credentials: fixHint `Run \`trent setup --mode local\` to use qwen3.5:9b on Ollama at
  http://127.0.0.1:11434, which needs no key; or \`trent config set GEMINI_API_KEY <your-api-key>\`.`,
  `details.suggested: "local"`.

### For the lead (not done here)
- Docs lines for `docs/getting-started.md` sections 5 and 7 are in the C9 report; README/docs untouched.
- Out-of-list edits needing sign-off: `setup/types.ts` (1 field), `commands/groups/diagnostics.ts` (2 lines).
- With no runtime, detect.ts still ends its guidance with `trent setup --mode quick --provider ollama
  (or lmstudio)` because the brief froze that text; `--mode local` (which names the URLs it tried and
  the start commands) is the better pointer there, as a follow-up.
- Nothing committed, staged or stashed.
