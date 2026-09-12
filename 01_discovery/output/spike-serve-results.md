# Spike: desktop sidecar — VERDICT: falsified on every clause. Plan must change.

## What the design claimed vs what the repo contains
| claim | reality |
|---|---|
| "Tauri v2 app" | **Tauri v1.6** (`Cargo.toml: tauri = "1.6"`), v1 `allowlist`/`package` schema |
| "wraps the Next.js web app" | `distDir: "../dist"` — ships its OWN Vite SPA. `externalBin: []` — **no sidecar configured at all** |
| "spawn `trent serve`" | **NAME COLLISION.** `trent serve` already exists: `commands/index.ts:392` starts the A2A server on port 7895 |
| "Bun-compiled binary as the sidecar" | no bun build config exists; `apps/cli` bin points at `dist/index.js` (Node/tsx) |

## Next.js CANNOT be compiled into a Bun binary
- Programmatic `import next` entry: compile **exit 1**, unresolved `next` -> critters, webpack, react-server-dom-webpack, sass.
- `bun build --compile .next/standalone/server.js`: compile **exit 1**, 27 errors, 20 unique unresolved
  specifiers (webpack + 8 `webpack/lib/*`, 4 `react-server-dom-*`, critters, sass, turbopack runtime...).
- Marking them all `--external`: compile **exit 0**, 169 MB — **and this is the trap.** Run in a clean
  directory it boots and serves `/` 200, but the HTML is an empty shell:
  `/_next/static/chunks/webpack-*.js` **404**, `/login` **404**, `/dashboard` **404**, `/api/health` **500**.
  Exit 0 was only reachable by externalizing the parts that make it a server.

## What DOES work: Bun as a RUNTIME, not a compiler
`bun run .next/standalone/server.js` -> `Ready in 301ms`, `/` **200**, `/api/health` **200**, with
`DATABASE_URL` unset. Full app, static chunks, API routes, Prisma — all fine.
Health route already degrades cleanly: `{"status":"ok","checks":{"database":"ok"},"readiness":{"db":"memory"}}`.

## Two pre-existing bugs found in the web app
1. **`outputFileTracingRoot: process.cwd()` is wrong for this hoisted monorepo.** Deps live at the repo
   root, so tracing emits **no node_modules** into `.next/standalone/` and writes a partial, broken
   `next` copy into `apps/web/node_modules/`, shadowing the real install (`Cannot find module
   './cpu-profile'`). Standalone output is not portable until this points at the repo root.
2. `output: "standalone"` is not set in `next.config.ts`; the spike used the documented
   `NEXT_PRIVATE_STANDALONE=1` env override rather than editing the file
   (`next-config-security.test.ts` asserts against that config).

## Revised desktop model
- Ship the **Bun runtime binary** + the whole `.next/standalone/` tree + `.next/static` + `public/`
  as Tauri **resources**. This is a directory, not a file.
- `tauri.bundle.externalBin: ["binaries/bun"]` with target-triple-suffixed copies;
  spawn with `shell:allow-spawn`, bind `HOSTNAME=127.0.0.1` on a **random free port**, wait for accept,
  then point the window at it. Kill the child on window close. Never hardcode 3000.
- **Rename the command.** `trent serve` is taken by A2A. The web server becomes `trent web`.
- **Retire the phrase "zero-dependency single binary" for the desktop.** It is true for the CLI/TUI,
  false for anything wrapping Next.js. The defensible claim is **"no external dependencies to install"**,
  since the Bun runtime is vendored.

## Rejected alternatives
- Node runtime on the user's machine: works, but adds a Node 22 requirement Bun already satisfies.
- Remote URL only: destroys offline use and the local-first security story.
- TUI-in-a-terminal-view (the previous agent's shape): **not** vindicated — a real wrap is achievable.
