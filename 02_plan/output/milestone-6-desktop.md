# Milestone 6 — Desktop (task-level)

Rewritten after a spike falsified the original plan on every clause. What was assumed, and what is true:

| assumed | measured |
|---|---|
| the app is Tauri v2 | it is **Tauri v1.6** with the v1 allowlist schema |
| it wraps the Next.js app | it ships its **own Vite SPA**; `externalBin` is empty, no sidecar exists |
| `trent serve` spawns it | `trent serve` is **already taken** — it starts the A2A server on port 7895 |
| the Bun binary serves Next.js | **Next.js cannot be Bun-compiled.** 20 unresolved specifiers. Forcing it with `--external` yields a 169 MB binary that boots, serves an empty shell, and 404s its own chunks |

What does work, measured: **Bun as a runtime.** `bun run .next/standalone/server.js` starts in 301 ms and
serves `/` and `/api/health` with 200, with no database configured.

---

## 6.1 — Fix the web build's portability first
`apps/web/next.config.ts` sets `outputFileTracingRoot: process.cwd()`, which is wrong for this hoisted
monorepo: dependencies live at the repo root, so tracing emits **no node_modules** into
`.next/standalone/` and writes a partial, broken copy into `apps/web/node_modules/` that shadows the
real install. The standalone build is not portable until this points at the repo root.
- This is a change to `apps/web`, so it is its own commit with its own test, and it must keep
  `apps/web/next-config-security.test.ts` passing.
- **RED test:** build with standalone output, then run the server from a directory with the repo's
  `node_modules` renamed away, and assert `/api/health` returns 200.

## 6.2 — Rename the command
`trent serve` becomes `trent a2a serve`; the web server is `trent web`. Do not overload a name that
already means something.
- **RED test:** `trent a2a serve --json` still starts the A2A server; `trent web --json` reports the
  port it bound.

## 6.3 — `trent web`
Execs the vendored Bun runtime against the shipped `.next/standalone/server.js` with
`HOSTNAME=127.0.0.1` and a **random free port**, never a hardcoded 3000. Waits until the port accepts a
connection before reporting ready. Kills the child on exit, including on signal.
- **RED tests:** two concurrent invocations get different ports; the child is reaped on parent exit;
  a port already in use does not crash but selects another.

## 6.4 — Migrate to Tauri v2
`cargo tauri migrate` converts the v1 allowlist into v2 capabilities, which is precisely the invalid
`allowlist.systemTray` key that blocks today's build. Rust is now 1.98.1, above the 1.77.2 minimum, and
both macOS targets are installed.
- Tray moved **into core** in v2 (`tauri::tray::TrayIconBuilder`); there is no tray plugin.
- Plugins: global-shortcut, notification, updater 2.10.1, shell 2.3.5.
- **Author the icon.** There are zero image assets in the repo; the logo is pure CSS. Generate a
  1024x1024 PNG of the compact mark — an Inter Black `T` in bone on obsidian with a mint dot at upper
  left and a soft mint glow — then run `tauri icon`.
- **RED test:** `cargo tauri build --debug` exits 0 and produces a bundle.

## 6.5 — Wrap the web app, do not rebuild it
The window loads `http://127.0.0.1:<port>`. The Bun runtime and the `.next/standalone` tree ship as
Tauri **resources**; the binary is registered via `bundle.externalBin` with target-triple suffixes and
spawned with `shell:allow-spawn` (not allow-execute — this is a long-running server).
- **Security, stated plainly:** v2's `remote.urls` grants the listed origin access to the IPC layer and
  therefore to local system capabilities. Scope it to exactly `http://127.0.0.1:<port>`, grant the
  minimum permission set, never a wildcard, and set an explicit CSP.
- **RED test:** the shipped config contains no wildcard origin, and the window's URL matches the port
  the sidecar actually bound.

## 6.6 — Tray, notifications, updater
Tray colour reflects real fleet state read from the running app, not a literal. Notifications fire for
approval required, mission complete, and budget thresholds. The updater checks a real URL.
- **RED test per feature:** change the underlying state and assert the tray/notification changes. The
  previous implementation had a tray whose "Pending Approvals (0)" was a static string.

## 6.7 — Retire the false claim
The desktop is **not** a single binary and never can be while it wraps Next.js. The honest and still
strong claim is **"no external dependencies to install"**, because the Bun runtime is vendored inside
the bundle. Fix this wording everywhere, including the README and docs.

## Done when
`cargo tauri build` succeeds, the app launches, loads the real web UI on a random port, the tray
reflects real state, and no wildcard origin appears in the shipped capability file.
