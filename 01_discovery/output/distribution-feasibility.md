# Distribution & desktop feasibility (Stage 00) — tested, not assumed

## Bun --compile: WORKS. Recommended.
Bun 1.4.2. One host (darwin-arm64) cross-compiled all four targets in a single step:
darwin-arm64 61MB, darwin-x64 68MB, linux-x64 79MB, windows-x64 84MB. Only the host binary was
executed; the other three verified by `file` signature. Budget ~290MB for a 4-platform release.

### Three traps, all verified by running binaries
1. **Ink needs `react-devtools-core` as a REAL dependency.** Ink 7 declares it as a peer that npm does
   not auto-install, so the naive build fails to resolve. `--external react-devtools-core` compiles
   exit 0 and then **dies at runtime** — a green build with a dead binary. Fix: `bun add react-devtools-core`.
   **Rule: `--external` is banned as a compile fix.**
2. **Use `bun:sqlite`, never `better-sqlite3`.** better-sqlite3 cross-compiled exit 0 while embedding a
   host absolute path and two Mach-O headers inside an ELF binary. Native `.node` addons do not fail
   the cross-compile; they fail on the user's machine. **Rule: no `.node` addons in the CLI graph, and
   CI must RUN each binary on its native OS — compile exit 0 proves nothing.**
3. **Prisma cannot go in the binary.** Its query engine is a per-platform Rust addon. Options:
   `engineType = "client"` + driver adapter (Prisma >= 6.16), or keep `@prisma/client` out of the CLI
   import graph entirely. **Recommendation: keep it out.**

Node SEA rejected (no automatic bundling, macOS arm64 only tested, still "active development").
`pkg` rejected (unmaintained).

## Tauri: 2.10.1 is current. ONE HARD BLOCKER.
**Local Rust is 1.75.0; Tauri v2 MSRV is 1.77.2.** The v2 build cannot succeed until the toolchain is
updated. Also: only `aarch64-apple-darwin` target installed (no Intel/universal build), and the Tauri
CLI is not installed. Fix: `rustup update stable && rustup target add x86_64-apple-darwin`.

- `cargo tauri migrate` parses the v1 `allowlist` and generates capability files — it directly fixes
  the invalid `allowlist.systemTray` that blocks the current build.
- Tray moved INTO CORE in v2 (`tauri::tray::TrayIconBuilder`); there is no tray plugin.
- Plugins: global-shortcut, notification, updater 2.10.1, shell 2.3.5 (Rust and JS versions in sync).
- Wrapping Next.js: `app.windows[].url` accepts a localhost URL. v1's `dangerousRemoteDomainIpcAccess`
  is gone; v2 uses capability `remote.urls`. **Security: listing an origin there grants it IPC access
  to local system capabilities.** Scope to exactly `http://localhost:<port>`, minimum permissions,
  never a wildcard, and set `app.security.csp`. (cf. GHSA-57fm-592m-34r7)
- Sidecar: `bundle.externalBin`, binary on disk must carry the target-triple suffix; grant
  `shell:allow-spawn` (not allow-execute) for a long-running server. The Bun-compiled `trent` IS the sidecar.
- `tauri icon <squared 1024 PNG>` generates the icon set (exact filenames unverified).

## Ink: the plan's premise was WRONG — no change needed
`ink@^7.1.1` is current (`latest: 7.1.1`) and its peer range REQUIRES `react >= 19.2.0`. The existing
dependency pairing is correct. Add `react-devtools-core@^8`. Prefer `@inkjs/ui@^2` over separate
ink-text-input / ink-spinner / ink-select-input. 3-pane layout needs no library (Yoga flexbox is built in).
**Mouse support does not exist in Ink** — it requires hand-written SGR escape handling
(`\x1b[?1000h\x1b[?1006h`, parse `\x1b[<b;x;yM`, and ALWAYS disable on exit). Budget it as custom work.

## Terminal input (verified)
- Raw mode stops the OS generating SIGINT, so byte `0x03` arrives as data — that is exactly what makes
  "Ctrl+C aborts the stream but keeps the REPL" possible. Guard on `process.stdin.isTTY`.
- **Ctrl+J (0x0A) is the only universally reliable newline.** Alt+Enter arrives as `\x1b\r`.
  **Shift+Enter is indistinguishable from Enter** unless the terminal supports the Kitty keyboard
  protocol (push `\x1b[>1u`, read `\x1b[13;2u`, and MUST pop `\x1b[<u` on exit). Never make
  Shift+Enter the only newline binding.
- Mid-stream abort verified live: the fetch aborted 150ms into a 5s stream and the process survived.
  **Gotcha: `ac.abort(reason)` yields an error whose `name` is NOT "AbortError".** Branch on
  `ac.signal.aborted`, not on `e.name`.

## Machine state note
The Bun installer appended a PATH/completions block to `~/.zshrc` despite BUN_INSTALL being redirected.
The agent reverted it and I verified: 0 bun references, 64 lines, file ends at the p10k line.
