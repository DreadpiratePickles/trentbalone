# The 16-item anti-pattern checklist — how each item is PROVEN

15 items come from the master prompt. Item 16 was forced by the independent review, which observed that
not one of the original 15 asks what survives a process restart — the exact blind spot that would let a
broken product tick every box.

A row may only be marked PASS with a command and its exit code. "Looks correct" is not evidence.
An item that cannot be tested on this machine is marked `untested-on-this-platform` and moved to CI.
It is never marked PASS.

| # | Claim | The command that proves it | Why this command and not an easier one |
|---|---|---|---|
| 1 | The REPL calls the real model gateway | live streaming test asserting >1 token frame, the sentinel echoed, output NOT matching `/^Trent proxy response/`, and provider-reported `outputTokens > 0` | A single-blob response or the canned proxy literal both look like success in a naive test |
| 2 | Core imports >= 8 real `lib/` files | an import-graph test that COUNTS distinct `apps/web/lib` files dynamically | A hard-coded count would keep passing after a wrapper is deleted |
| 3 | `curl \| bash` downloads a real binary | run the installer in a container with no clone, no Node, no Bun; then `trent --version` | The previous installer resolved to `$HOME/apps/cli/...` and worked only on the author's machine |
| 4 | `tauri build` succeeds | `cargo tauri build --debug`, exit 0, and the bundle launches | `vite build` passing proves nothing about the desktop app |
| 5 | Colours match the app's tokens | grep every surface for hex literals; assert each appears in `design-tokens.json` | The previous app invented `#8B5CF6` purple that exists nowhere in the product |
| 6 | Gateway adapters make real API calls | send and receive one real message per configured platform | Seven adapters previously had empty method bodies and passed their tests |
| 7 | The egress proxy is TLS-intercepting | assert a CONNECT handler exists and that an unauthenticated request is REFUSED, not forwarded | The previous proxy was an open relay that forwarded anything |
| 8 | Every doctor check inspects something | induce a real failure per check and assert it reports it | Three checks previously returned green from inside a try block that could not throw |
| 9 | Tests prove behaviour | mutate state, re-run, assert output changed | The previous CLI's only test asserted its own canned strings |
| 10 | History is preserved | `git rev-list --count HEAD` >= 174 and `git log --follow` crosses the move | **PASS** — 174 commits, verified |
| 11 | Ctrl+C interrupts, does not exit | inject `0x03` mid-stream; assert stream stops AND process lives | The previous REPL exited on Ctrl+C |
| 12 | TUI help advertises only bound keys | parse the help modal, assert every key it names has a handler | The previous help advertised `m/f/t/d/?` while the code bound Ctrl+M/F/T/D/H |
| 13 | `--json` on ALL commands | enumerate commands from the parser dynamically; assert each accepts `--json` and emits parseable JSON | Previously 3 of 28. A hard-coded list would let a new command forget |
| 14 | Budget comes from real costs | three turns; assert the ticker equals the sum of real gateway costs | Previously hard-coded `0.12` and `0.00` |
| 15 | Slash commands are functional | mutate underlying state; assert each command's output changes | Five commands previously returned static text |
| **16** | **What survives a process restart** | trigger an approval, kill the process, restart; assert the approval is still pending and answerable; assert the budget and audit chain persist | **Added by review.** Everything can look green in one process and lose the approval, the spend and the audit trail the first time a user closes their terminal |

## Additional gates this project adopts beyond the checklist
- **Exactly one `run_done` per run.** Without `TRENT_QUEUE_FALLBACK=disabled` every job executes twice
  while still reporting success. Measured: 31 worker invocations for a 3-step run. This regression
  guard runs in CI.
- **Run every cross-compiled binary on its native OS.** A native module cross-compiled with exit 0 and
  produced a Linux binary containing macOS headers. Compile success is not evidence.
- **No `--external` as a build fix.** It produced a binary that compiled cleanly and died at runtime.
- **No secret in any artifact.** Scan the full history, not just the tip.
