# Desktop app

`apps/desktop/` is a Tauri v2 app that wraps the real web application. It has no frontend of its
own beyond a splash page: the window shows `apps/web/` served by a runtime the bundle ships.

## What it is today

- **Tauri v2.** `src-tauri/Cargo.toml` pins `tauri = "2"` and `tauri-build = "2"`, with the
  `tray-icon` feature and the v2 `shell`, `notification` and `global-shortcut` plugins; the npm
  side pins `@tauri-apps/cli ^2.11`.
- **The real web UI.** `src-tauri/src/server.rs` spawns the vendored Bun runtime
  (`externalBin: binaries/bun`) on the shipped Next.js standalone tree (`resources/server`) on a
  random loopback port, with `TRENT_QUEUE_FALLBACK=disabled` set, and keeps the window hidden
  until the port accepts a connection. `main.rs` then navigates the window to `http://127.0.0.1:<port>`.
  Shutdown is idempotent and wired to window close, destroy, exit, tray quit and SIGINT.
- **A narrow capability.** `src-tauri/capabilities/localhost-web-ui.json` grants the web origin
  `http://127.0.0.1::port` (scheme and host literal, only the port variable) exactly two
  permissions: event listen and unlisten. No window control, no filesystem, no shell. An explicit
  CSP replaces `csp: null`. `tests/capabilities.test.ts` asserts no wildcard in any capability
  file, loopback-only origins, `shell:allow-spawn` present and `shell:allow-execute` absent.
- **A tray that reads real state.** `src-tauri/src/tray.rs` builds the menu, title and tooltip
  from a fleet snapshot taken from the health endpoint, the config and trace records, with spend in
  integer cents. A source that is unavailable renders as unavailable, not as zero. The tray icon
  itself does not change; only the labels do.
- **A global shortcut**, `CommandOrControl+Shift+T`, which shows or hides the main window.
- **Resources staged before build.** `scripts/prepare-resources.mjs` (wired as
  `build.beforeBuildCommand`) stages the Bun binary for the target triple and runs the Next.js
  standalone build from the repository root so `outputFileTracingRoot` resolves without editing
  `apps/web/`.

## Building

```bash
cd apps/desktop
npm run build:debug        # tauri build --debug  (exit 0 on this machine, commit acb56ee)
npm run build              # tauri build
npm test                   # capability and shell tests
npm run test:rust          # cargo test for tray, server and http helpers
```

## Installing from the CLI

```bash
trent desktop install [--to <dir>] [--force] [--system]
trent desktop launch
trent desktop status [--no-check]
trent desktop uninstall [--yes]
```

`install` downloads the desktop bundle from GitHub Releases and verifies the release signature with
the same embedded key the CLI updater uses. No release has been published yet, so today it has
nothing to download; build locally with the commands above.

## The "single binary" claim is retired for desktop

Next.js cannot be compiled into one binary. A spike measured 20 unresolved specifiers, and building
with `--external` produced a 169 MB binary that 404s its own chunks
(`01_discovery/output/spike-serve-results.md`). The bundle therefore ships the Bun runtime plus
`.next/standalone/` as Tauri resources. The honest claim is **no external dependencies to
install**, not "a single binary".

## Not yet implemented

- A code-signed installer: `signingIdentity` is `null` in `tauri.conf.json`, and no `.dmg`, `.msi`,
  `.AppImage` or `.deb` has been published.
- A tray icon that changes with fleet state. The menu, title and tooltip change; the icon does not.
- `trent web --start` as a way to run the same server outside the desktop app. The desktop app
  starts its own sidecar; the CLI command still reports readiness only.
