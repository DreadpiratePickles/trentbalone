# Trent Fleet

Trent Fleet is a multi-agent AI cofounder platform that runs from a terminal. It wraps an existing
Next.js application containing a real orchestrator, a 164-specialist agent catalog and a
self-improvement loop, and adds a CLI, a TUI and a desktop shell on top of it without rewriting any
of it. It is a work in progress: the command surface, the doctor, the config layer, the egress proxy
and the agent catalog are built and tested; the installer, the packaged binary and the desktop
wrapper are not.

## Status

There is no installer and no released binary. The only supported way to run Trent today is from a
clone, through `npm run cli --`. See [docs/getting-started.md](docs/getting-started.md).

Test counts, measured on 2026-09-12:

| Suite | Command | Result |
|---|---|---|
| CLI and core | `npx vitest run --exclude "**/*.live.test.ts"` | 68 files, 726 tests, 717 pass, 9 skip |
| Live model gateway | `npm run test:live` | 3 tests, requires `GEMINI_API_KEY`, skipped without one |
| Pre-existing web app | `cd apps/web && npm test` | 505 files, 2743 tests, exit 0 |

Two of the CLI and core tests time out at five seconds when the whole suite runs in parallel on a
loaded machine (`wrapped-modules.test.ts`, `derive-sqlite-schema.test.ts`). Run alone they pass in
7.2 seconds. Treat a timeout there as contention, not a regression.

The root `vitest run` covers `packages/` and `apps/cli/` only. The web app has its own suite and its
own setup file; run it with `npm run test:web`.

## What is actually different about it

Three things are built, tested and not matched by the closest comparable tool:

- **164 pre-configured specialists.** `npm run cli -- fleet list --json` returns 173 agents: 164
  catalog specialists across 13 divisions, plus 9 core seats. They are data in the wrapped
  application, not prompts invented at runtime.
- **Real multi-agent orchestration.** The CLI drives the application's own orchestrator with its own
  drain loop, and a run survives a process restart. Approvals, budget and the audit chain persist.
- **Credential-brokering egress isolation.** A sandboxed process never holds a real API key. It holds
  an opaque token that only resolves at a TLS-intercepting local proxy, which denies by default. See
  [docs/security.md](docs/security.md).

## Quickstart

```bash
git clone <your remote> trent && cd trent
npm install
npm run cli -- doctor
```

`doctor` will report failures on a fresh clone. That is the intended first experience: it tells you
what to set up. Then:

```bash
npm run cli -- setup --mode quick
export TRENT_QUEUE_FALLBACK=disabled
npm run cli --
```

`TRENT_QUEUE_FALLBACK=disabled` is mandatory, not advisory. Without it every job executes twice while
still reporting success, which roughly quadruples the model bill silently. Details in
[docs/configuration.md](docs/configuration.md).

## Architecture in five sentences

`apps/web/` is a pre-existing Next.js 15 application and is read-only; nothing in this repository
modifies it. `packages/trent-core/` wraps it, importing 19 real modules from `apps/web/lib/` behind
five ports (gateway, store, trace sink, approval, audit) so the CLI never duplicates application
logic. `apps/cli/` is the command surface, a REPL and an Ink TUI, all built on the same session
engine and the same registry, which attaches `--json` to every command before a handler can see it.
`apps/desktop/` is a Tauri v1 shell with its own React frontend; it does not yet wrap the web app.
Persistence is Prisma against a local SQLite file at `~/.trent/trent.db` in standalone mode, or HTTP
to a running web server in connected mode, from one schema.

## Documentation

| Page | Covers |
|---|---|
| [getting-started.md](docs/getting-started.md) | Clone to first real conversation |
| [configuration.md](docs/configuration.md) | Config schema, the yaml/env split, profiles, the env contract |
| [doctor.md](docs/doctor.md) | The 13 checks, exit codes, `--json`, `--fix` |
| [fleet.md](docs/fleet.md) | The catalog, core seats, packs |
| [skills.md](docs/skills.md) | The skills hub and the pre-install scanner |
| [gateway.md](docs/gateway.md) | Messaging platforms, and which ones are stubs |
| [terminal.md](docs/terminal.md) | Sandbox backends |
| [desktop.md](docs/desktop.md) | The Tauri shell and what it cannot do yet |
| [security.md](docs/security.md) | Egress brokering, redaction, file permissions, approvals |
| [troubleshooting.md](docs/troubleshooting.md) | Failure modes we have actually hit |

`AGENTS.md` and `CONTEXT.md` hold the workspace invariants and routing. `02_plan/output/design-doc.md`
is the current design.

## Not yet implemented

- An installer. `scripts/install.sh` is the previous agent's version: it downloads nothing, resolves
  paths relative to the author's home directory, and prints colours that are not in the product
  palette. Do not run it.
- A compiled binary. `apps/cli/package.json` declares `bin.trent` pointing at `dist/index.js`, which
  is not built.
- A hosted install URL. `agent.let-trent.uk` exists as a DNS record pointing at GitHub Pages. It
  serves nothing.
- The desktop app wrapping the web app. See [docs/desktop.md](docs/desktop.md).
- `trent web --start`. The command validates and reports; starting the server is a later milestone.
- Seven of the eight messaging adapters. See [docs/gateway.md](docs/gateway.md).
