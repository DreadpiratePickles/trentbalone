# 2026-09-26 — attach-chromium CI: why the throwaway Chromium never writes DevToolsActivePort on Linux

Agent (Opus), single brief, no subagents. Branch `feature/trent-fleet-v2`, HEAD `df1ce0f`.
No commit, stash, checkout, reset or push; single test files only; no secrets printed.
Edit scope: `packages/trent-core/src/tools/browser/browser.attach.chromium.test.ts` (and, only if a
shared helper is cleaner, `chromium.ts` with `// [CI]` marks) plus this log. `attach*.ts`, `session.ts`,
`index.ts`, `launch.ts` are off limits.

## Brief
Since de73c39, CI job "core tests (@trent/core + cli)" on ubuntu-latest fails 3/3 on exactly
`browser.attach.chromium.test.ts`: `timed out waiting for DevToolsActivePort`, then `Hook timed out in
30000ms` in beforeAll. The sibling `browser.chromium.test.ts` (Playwright launcher, same binary) passes.
The attach harness spawns Chromium by hand with `stdio: "ignore"` and ignores an early exit.

## Read first
AGENTS.md; the attach test; `chromium.ts`; the sibling test; `.github/workflows/ci.yml`.

## Log
- Read the files above. `findChromium` order: `TRENT_BROWSER_PATH` (returned only if executable,
  else null), then PATH names `chromium, chromium-browser, google-chrome, google-chrome-stable, chrome,
  brave-browser, microsoft-edge`, then `/usr/bin/{chromium,chromium-browser,google-chrome,
  google-chrome-stable}`, `/snap/bin/chromium` on Linux. `ci.yml` has NO Playwright install step and no
  browser setup at all, so CI uses whatever the runner image ships.
- CI log (`gh run view 36222759668 --log`): runner image `ubuntu-24.04`, version `20260920.314.1`.
  The attach file: `5 tests | 5 skipped`, `50161ms`, then `timed out waiting for DevToolsActivePort`
  (line 113) and `Hook timed out in 30000ms` (afterAll, line 137). The sibling
  `browser.chromium.test.ts` RAN on the same job: `4 tests`, `21380ms`, green. So `findChromium` did
  return an executable on the runner, and Playwright could launch it.
- What `findChromium` returns there. The image's `install-google-chrome.sh` at tag
  `ubuntu24/20260920.314` (read with `gh api repos/actions/runner-images/contents/...`) installs the
  Google Chrome deb AND a Chromium snapshot unzipped to `/usr/local/share/chromium/chrome-linux/chrome`,
  then `ln -s` it to `/usr/bin/chromium` and `/usr/bin/chromium-browser`. `chromium` is the FIRST name
  in `PATH_NAMES`, so `findChromium` returns `/usr/bin/chromium`: the unzipped snapshot, not
  Google Chrome, not a Playwright download (ci.yml installs no Playwright browser).
- Why that binary dies when spawned by hand. Ubuntu 24.04 restricts unprivileged user namespaces
  through AppArmor; a binary with no AppArmor profile cannot use the namespace sandbox, and the
  snapshot's `chrome_sandbox` is not a setuid `chrome-sandbox`, so Chromium aborts at startup with
  `No usable sandbox!` (LOG(FATAL), i.e. killed by a signal). Public confirmation on this exact image
  layout: actions/runner-images#12096 ("chromium in ubuntu latest ... not possible to run it", 24.04,
  `/usr/bin/chromium -> /usr/local/share/chromium/chrome-linux/chrome`, `chrome_sandbox` present but
  not setuid; google-chrome works).
- Why the sibling passes with the same binary: Playwright 1.63 (`node_modules/playwright-core/lib/
  coreBundle.js`, `_innerDefaultArgs`) pushes `--no-sandbox` whenever `chromiumSandbox !== true`, and
  `launch.ts` never sets `chromiumSandbox`. Its `chromiumSwitches` list also carries
  `--disable-dev-shm-usage`, `--no-first-run`, `--no-default-browser-check`, `--password-store=basic`,
  `--use-mock-keychain`, `--disable-features=...` and more. The hand spawn had none of the sandbox,
  shm or keychain switches.
- The afterAll hang is itself evidence of a signal death: `child.exitCode === null` is also true for a
  process that was KILLED BY A SIGNAL (Node sets `signalCode`, not `exitCode`), so afterAll registered
  `once("exit")` on a process whose exit had already fired, and waited out its 30 s. 20 s (port wait)
  + 30 s (afterAll) = the 50.1 s CI reported.
- RED, reproduced locally with the CI signature: a fake "Chromium" in the scratchpad that prints the
  `No usable sandbox!` line to stderr and `kill -TRAP`s itself, pointed at by `TRENT_BROWSER_PATH`:
  `TRENT_BROWSER_PATH=<scratch>/fake-chrome-crash.sh TRENT_QUEUE_FALLBACK=disabled npx vitest run
  packages/trent-core/src/tools/browser/browser.attach.chromium.test.ts` -> exit 1,
  `5 tests | 5 skipped 50102ms`, `timed out waiting for DevToolsActivePort`, `Hook timed out in
  30000ms`. Same two errors, same 50.1 s, and the stderr line that would have named the cause is lost.

## Decision: keep a hand-spawned Chromium, launched with Playwright's switches, and make it observable
Options weighed:
- `chromium.launchPersistentContext(dir, { args: ["--remote-debugging-port=0"] })` would give a
  known `DevToolsActivePort`, but the harness's own Playwright client then sits on the same browser
  over `--remote-debugging-pipe`: it auto-attaches to every target (including the tabs Trent opens),
  applies its default-context emulation and download behaviour, and closes the browser when it
  disconnects. H5 is "a browser Trent does NOT own, with nobody else driving it": the owner's Chrome.
  A second controller in the same browser weakens exactly the `noDefaults` / tabs-survive-detach
  claims this file exists to prove.
- `chromium.launch()` / `launchServer()` refuse `--user-data-dir` in `args` and keep their profile in
  a private temp dir; `launchServer` exposes a Playwright-protocol websocket, not a CDP endpoint.
- `chromiumSwitches` is not importable: in 1.63 it lives inside the bundled `coreBundle.js`, and the
  package's public API has no `defaultArgs`.
Chosen: keep `spawn`, and pass the switches Playwright 1.63 puts on every Chromium it launches
(mirrored in the test, with the source named), including `--no-sandbox` (the one that matters on the
runner), `--disable-dev-shm-usage`, `--disable-gpu`, `--password-store=basic`, `--use-mock-keychain`.
Pipe stdout/stderr into a bounded tail, record exit code AND signal, and handle a spawn `error`.
Early exit before the port file -> the suite SKIPS with the exit status and the last output lines
(logged "A skip is NOT a pass"); a live process that never writes the file -> beforeAll FAILS with
that output. afterAll waits on an exit promise created at spawn (fixes the signal-death hang) and
escalates SIGTERM -> SIGKILL. Hook timeout 60 s; the port wait is 30 s so the named error lands first.

## GREEN (harness behaviour, simulated failure modes)
- Crash (same fake, `kill -TRAP` after the FATAL line): exit 0, `5 tests | 5 skipped`, 138 ms. Logged:
  `SKIPPED: Chromium could not start (signal SIGTRAP), so nothing was attached to. A skip is NOT a
  pass.` + `Chromium (<fake>) is gone: signal SIGTRAP. Its last output:` + the FATAL line. Each test's
  skip note carries the short reason (vitest 3.2.7 `context.skip(note)` from `beforeEach`).
- Hang (fake prints one line, then `exec sleep 300`): exit 1, ONE error only:
  `timed out after 30000 ms waiting for DevToolsActivePort` + `Chromium (<fake>) is still running.
  Its last output:` + the line. No afterAll hook timeout; `pgrep` finds no leftover process.

## Verification (this Mac, load average ~95-120)
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/browser/browser.attach.chromium.test.ts`
  (findChromium -> `/Applications/Google Chrome.app/...`): run 1 exit 0 `5 passed` 18.72 s; run 2
  exit 0 `5 passed` 10.60 s; run 3 exit 0 `5 passed` 18.06 s. RUN, not skipped.
- Same command with `TRENT_BROWSER_PATH` = Playwright's cached Chromium (`ms-playwright/chromium-1234/
  .../Google Chrome for Testing`, 151.0.7922.34): exit 0, `5 passed`, 18.42 s.
- Also, informative: `TRENT_BROWSER_PATH` = `ms-playwright/chromium_headless_shell-1234/.../
  chrome-headless-shell`: exit 0, `5 passed`, 12.04 s (`--headless=new` is harmless there).
- `cd packages/trent-core && npm run build` (`tsc -p tsconfig.json --noEmit`, includes `src/**/*`, so
  the test file is type-checked): exit 0.
- Cleanup: the RED run with the OLD harness left one empty `trent-attach-chrome-*` temp dir (its
  afterAll timed out before `rmSync`); removed it. No `trent-attach-chrome-` process remains.
- Not verifiable from here: a real ubuntu-24.04 run (no push authorised). The Linux cause is
  inferred from the runner-image script, runner-images#12096, Playwright's `--no-sandbox`, and the
  exact local reproduction of CI's two errors and 50.1 s duration with a signal-killed start.
  If CI still cannot start that Chromium, the suite now SKIPS with the exit signal and Chromium's own
  last lines in the job log instead of timing out blind.

## Files changed
- `packages/trent-core/src/tools/browser/browser.attach.chromium.test.ts` (208 -> 325 lines).
- `docs/sessions/2026-09-26-attach-chromium-ci.md` (this log, new).
`chromium.ts` untouched: a helper there would be test-only code in a production module.

## Follow-up: cleanup race on CI (coordinator, after run 36226196095)
- CI run 36226196095: Chromium starts on ubuntu-24.04, the suite RUNS (`5 tests`, 6411 ms, all five
  green); 511/512 files, 4883 tests passed. One failure, in afterAll line 262:
  `ENOTEMPTY: directory not empty, rmdir '/tmp/trent-attach-chrome-S6qmN6/Default'` (errno -39).
  That `rmSync` already had `maxRetries: 5, retryDelay: 200` (~3 s of linear backoff), and `stop()`
  had resolved on the browser process's `exit`. So something kept writing into `Default/` for more
  than 3 s after the browser process itself was gone: Chromium's own children (network/storage
  utility processes, renderers) outlive the browser process briefly and flush into the profile.
- They inherit the browser's stdout/stderr, which is why Node's `close` event (every holder of the
  stdio pipes has closed them) fires later than `exit`. That is the signal to wait for.
- The dir that run left, `/tmp/trent-attach-chrome-S6qmN6`, was on an ephemeral GitHub runner; the
  harness at that commit recorded nothing, and there is nothing on this Mac to remove for it. Local
  `trent-attach-*` dirs: only `trent-attach-probe-DuRdAT`, which is not this harness's (left alone).
- RED attempts (scratch wrapper `chrome-straggler.sh` runs the real Chrome and, on SIGTERM, leaves a
  python writer creating files in `<user-data-dir>/Default` after the "browser process" exits):
  with the OLD cleanup (resolve on `exit`, `rmSync` 5 x 200 ms) every one of 7 runs (Node 26 x4,
  Node 25 x3) left the temp dir behind: `rmSync` ran while the writer was live, and the dir came back
  (e.g. `trent-attach-chrome-BivbkE/Default` held `straggler-685..` after the rm had taken 1..684).
  The suite itself stayed green locally; ENOTEMPTY is a narrow race. At the fs level it does
  reproduce: scratch `rm-race.mjs` (same `rmSync` options, a writer live in `Default/`) failed on
  Node 25.8.2 with `ENOTEMPTY rm` after 13964 ms and on Node 23.5.0 with `EACCES rm`, and passed on
  others: exactly the kind of flake CI hit. (One Node 25 run failed differently,
  `connectOverCDP: Timeout 10000ms exceeded` in the adapter, at load average 816: machine load, not
  this harness; `launch.ts`'s timeout is off limits.) All leftover dirs from these runs removed.
- Fix (test file only): `stop()` now also waits for Node's `close` (all stdio holders gone, bounded
  10 s), after `exit`, after a 500 ms settle when it had to SIGKILL. Temp dirs are removed with
  `rmSync({ recursive, force, maxRetries: 8, retryDelay: 250 })`; if that still throws, one line
  `[browser.attach.chromium] left a temp dir behind (<code>); remove it by hand: <path>` and the
  suite goes on. afterAll timeout 30 s -> 45 s to fit 5 s TERM grace + 10 s children + ~9 s retries.
- GREEN: same straggler (holds stdio, 6 s, no sleep): exit 0, `5 passed`, and NO
  `trent-attach-chrome-*` dir left afterwards. Undeletable profile (`STRAGGLER_LOCK=1`: a 0555
  `Default/locked/f`): exit 0, `5 passed`, one line `left a temp dir behind (ENOTEMPTY); remove it by
  hand: .../trent-attach-chrome-OsV1A1`; removed by hand afterwards (`chmod -R u+w`, `rm -rf`).
- Not built: a cross-run "leftover record" sweep. Many agents run tests on this machine at once; a
  sweep of other runs' dirs risks deleting a live profile. The logged path is the record.
- Verification after the cleanup fix (load average 450-800):
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/browser/browser.attach.chromium.test.ts`
  run 1 exit 0 `5 passed` 12.02 s; run 2 exit 0 `5 passed` 5.79 s; run 3 exit 0 `5 passed` 7.46 s;
  no `trent-attach-chrome-*` dir left. `cd packages/trent-core && npm run build`: exit 0.
  Files: `browser.attach.chromium.test.ts` (325 -> 355 lines; the first fix is already in HEAD, this
  diff is the cleanup only) and this log.
