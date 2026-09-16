# Trent Fleet

Trent is a multi-agent AI cofounder that runs from your terminal. Nine seats (CEO, engineer,
growth, content, support, analyst, finance, browser, escalation) work a task through a real
orchestrator, share one company memory, run their tools inside a sandbox that never sees a real API
key, and improve their own prompts and skills under a human-gated loop. A catalog of 164 further
specialists can be installed on top.

It wraps an existing Next.js application (`apps/web/`, read-only) rather than rewriting it: the
CLI, REPL, TUI, desktop app and installer all sit on top of the application's own orchestrator,
catalog and self-improvement code.

## Install

The installer is written, tested and rendered at `scripts/install.sh` and `scripts/install.ps1`. It
is designed to be served as:

```bash
curl -fsSL https://agent.let-trent.uk/install.sh | bash
```

```powershell
irm https://agent.let-trent.uk/install.ps1 | iex
```

**That URL is not live yet.** As of 2026-09-13, `agent.let-trent.uk/install.sh` returns 404, no
GitHub release or git tag has been cut, and no workflow publishes the installer or signs a release.
Until the first release exists, run Trent from a clone:

```bash
git clone <your remote> trent && cd trent
npm install
export TRENT_QUEUE_FALLBACK=disabled
npm run cli -- doctor
npm run cli -- setup --mode quick
npm run cli --
```

`npm run cli --` is a stand-in for `trent`. Everywhere below, read `trent <args>` as
`npm run cli -- <args>` until you have an installed binary. See
[docs/getting-started.md](docs/getting-started.md).

What the installer does once a release exists (from `scripts/install.sh` and
[scripts/installer/THREAT-MODEL.md](scripts/installer/THREAT-MODEL.md)): detect OS and CPU,
resolve the release, download the binary and `SHA256SUMS` over HTTPS only from GitHub release
hosts, verify the `SHA256SUMS` signature against a public key embedded in the script, check the
binary's SHA-256 and byte length, install under `~/.trent/versions/<v>/`, add one PATH line, then
run `trent setup` and `trent doctor`. No sudo; nothing outside `$HOME`.

## Quick start

```bash
trent                       # the REPL; runs quick setup on first launch
trent --tui                 # full-screen Ink TUI on the same session engine
trent --continue            # resume the last conversation
trent doctor                # 13 health checks; exit 3 on a configuration failure
trent fleet list            # 173 agents: 9 core seats plus 164 catalog specialists
trent fleet install <id>    # install a specialist with its tools, skills and model
trent improve status        # traces, quarantined drafts, last sweep
trent --help                # every command, 50 lines
```

Add a model key with `trent config set GEMINI_API_KEY <key>` (or `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`). With no key, the REPL still runs but
prints a `DEGRADED` banner and marks every line, because the planner falls back to deterministic
plans and the critic auto-passes. Nothing marked `DEGRADED` came from a model.

`TRENT_QUEUE_FALLBACK=disabled` must be exported for `trent doctor` to pass. The orchestrator sets
it for its own runs; the doctor checks the raw environment. Details in
[docs/configuration.md](docs/configuration.md).

## What you get

- **A 9-seat fleet with 164 optional specialists.** `trent fleet list --json` returns 173 agents
  across 13 divisions. They are data in the wrapped application, not prompts invented at runtime.
- **Shared fleet memory and cross-agent recall.** One `MEMORY.md`/`USER.md` pair per profile,
  injected into every seat's prelude; completed step outputs from any agent are ranked against the
  current objective and recalled within a character budget; `fleet_search` searches every agent's
  past runs; skills one agent earned are listed and viewable by the others. Only two writers exist
  and both are locked and atomic. See
  [packages/trent-core/src/fleet-memory/README.md](packages/trent-core/src/fleet-memory/README.md).
- **Durable orchestration.** The CLI drives the application's own orchestrator with its own drain
  loop; a run survives a process restart. Approvals, budget and the audit chain persist in a local
  SQLite database at `~/.trent/trent.db`.
- **A REPL that streams the run.** Orchestrator events (run start, step start, step output, step
  end) render as they happen. Ctrl+C aborts the in-flight stream and leaves the process alive.
- **A doctor that fails honestly.** 13 checks; the credentials check makes one cheap authenticated
  call rather than testing for presence. Exit codes are documented in
  [docs/doctor.md](docs/doctor.md).
- **A self-improvement loop, human-gated.** See below.
- **Single-file binaries** for `darwin-arm64`, `darwin-x64`, `linux-x64` and `windows-x64`, compiled
  with `bun build --compile` by `npm run build:binary` and, in CI, executed on each target's native
  OS before a checksum is emitted (`.github/workflows/binary.yml`).

## Tools

Every seat's tools are Hermes-shaped toolsets (`02_plan/output/tools-build-spec.md`), implemented in
`packages/trent-core/src/tools/` and toggled with `trent tools --enable <toolset>` /
`--disable <toolset>`.

| Toolset | Tools | State |
|---|---|---|
| `file_ops` | `read_file`, `write_file`, `patch`, `search_files` | On by default; workspace-confined |
| `terminal` | `terminal`, `process_manage` | On by default; Docker sandbox (`trent-sandbox:1`, no network, caps dropped) or confined local backend |
| `code` | `execute_code` | On by default; python3/node inside the sandbox image |
| `delegation` | `delegate_task` | On by default; real delegated child steps, max 6 per run |
| `web` | `web_search`, `web_extract` | On by default; through the egress proxy, skipped with a visible reason when the proxy is off |
| `skills` | `skills_list`, `skill_view`, `skill_manage` | On by default |
| `cron` | `cronjob_manage` | On by default; prompt-injection scan on stored prompts |
| `plugins` | `plugins_list` + `~/.trent/plugins/*/plugin.json` commands | On by default; names cannot shadow built-ins, manifests must be 0600 |
| `memory` | `memory`, `fleet_search`, `fleet_skill_view` | Always on, registered by the fleet-memory hook |
| `browser` | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, ... | Opt-in; needs a Chromium on the machine, drives it through the egress proxy |
| `vision` | `vision_analyze` | Opt-in; sends the image to the configured model |
| `mcp` | `mcp_<server>_<tool>`, `mcp_status` | Opt-in; servers from `trent mcp add` (stdio or http) |

Quick setup turns on the first eight; blank-slate setup turns on `file_ops` and `terminal` only.
Every tool call goes through the approval floors in `tools/approval-floors.ts`; output over 24K
characters spills to a file.

## Connect to things

| Surface | Command | State |
|---|---|---|
| Telegram, Discord, Slack, WhatsApp, Signal, email, Teams, Home Assistant | `trent gateway setup <platform>`, `trent gateway start` | Eight adapters on each platform's real protocol, each with a wire test against a local server; live tests skip without credentials. Device pairing is default-deny; approvals are checked against a durable row. [docs/gateway.md](docs/gateway.md) |
| Agent-to-Agent protocol | `trent a2a serve`, `trent a2a card <agentId>` | A2A server (default port 7895) and signed agent cards. `trent serve` is a retired alias that exits 2 |
| Editors (VS Code, Cursor, Zed) | `trent acp` | ACP server |
| MCP connectors | `trent mcp` | Manage Model Context Protocol connectors |
| Web UI | `trent web` | Reports readiness only. `trent web --start` refuses: the server entry point is not built. The desktop app starts the web UI itself |
| Docker sandbox image | `trent sandbox build` | Builds `trent-sandbox:1` from `scripts/sandbox/Dockerfile`. Not published to a registry. [docs/terminal.md](docs/terminal.md) |

## Self-improvement

Every run writes traces and captures failure goldens. `trent improve sweep` re-scores each seat's
prompt against its eval suite (deterministic graders first, then an evidence-citing LLM judge whose
quotes the gate verifies), runs one GEPA reflection pass on a per-agent Pareto frontier, re-draws
flipped fixtures, and puts candidates in quarantine. Nothing goes live without
`trent improve promote <draftId>`; `rollback <iterationId>` restores what an iteration replaced;
`history` shows the ledger.

Guards, each with a test: a seat with no verifier cannot promote; a budget cap with a real cost
meter; a content-addressed cache for baselines and judge calls; saturation and proposal-length
guards; a private hold-out partition; a repetitive-loop tag. The shape follows the Stanford CS329A
material as applied in
[01_discovery/references/cs329a-applied.md](01_discovery/references/cs329a-applied.md); all 17
tasks in its plan landed (session logs `docs/sessions/2026-09-13-cs329a-batch-2.md` and `-3.md`).

Not done: a scheduler (the sweep runs on command), a separate model family for judge and executor,
tree search, an offline reward model for seats without a verifier, and weighting the judge by the
judge-versus-human agreement ledger (the ledger exists; the weighting does not).

## Desktop

`apps/desktop/` is a Tauri v2 app. It spawns a vendored Bun runtime running the shipped Next.js
standalone tree on a random loopback port, waits for the port to accept, then navigates its window
to it. The window origin is granted event listen and unlisten and nothing else. The tray and
notifications read real state from the health endpoint, the config and trace records.
`cd apps/desktop && npx tauri build --debug` exits 0.

`trent desktop install | launch | status | uninstall` manage the installed app; `install` downloads
from GitHub Releases and verifies the signature, so it has nothing to download until a release is
cut. There is no code-signed `.dmg`, `.msi` or `.AppImage` yet. The honest packaging claim is "no
external dependencies to install", not "a single binary": Next.js cannot be compiled into one. See
[docs/desktop.md](docs/desktop.md).

## Security

- **Credential-brokering egress proxy.** A sandboxed process holds an opaque `trnt_egress_...`
  token, never a real key. A TLS-intercepting local proxy denies by default, once at CONNECT (host
  must be in `egress.intercept_domains`) and again on the decrypted request (token must resolve),
  then swaps the token for the secret. The REPL starts a session-scoped proxy; `trent egress start`
  runs a daemon. `packages/trent-core/src/egress/`.
- **Sandboxed execution.** Docker is the only isolating backend; `local` runs with no isolation.
  Those are the only two backends the schema accepts (config v3 collapses older `ssh`/`e2b`
  values to `docker`).
- **Secrets never printed.** `trent config get <SECRET>` reports `[set]`. Secrets route to
  `~/.trent/.env`, never `config.yaml`.
- **Signed releases, once they exist.** The installer embeds two public keys
  (`scripts/installer/keys/`): an Ed25519 minisign key (canonical; verified by `minisign` or
  OpenSSL 1.1.1+) and an ECDSA P-256 co-signing key for hosts whose only OpenSSL is LibreSSL
  (stock macOS) and for PowerShell. It refuses an unsigned release. The CI binary matrix emits
  `SHA256SUMS` but no workflow signs it or publishes a release yet; the signing commands are
  documented in `scripts/installer/keys/README.md`. Private keys are gitignored and not in the
  repository.
- **Human approvals** persist across restarts and are enforced in the REPL, the TUI and the
  messaging gateway.

Known, reported and not fixed defects in the wrapped application are listed in
[docs/security.md](docs/security.md).

## Contributing and tests

Measured on 2026-09-13 on this branch (`feature/trent-fleet-v2`):

```
npx vitest run --reporter=dot
  Test Files  135 passed (135)
       Tests  1235 passed (1235)
```

That covers `packages/` and `apps/cli/`. The wrapped web app has its own suite: `npm run test:web`.
Live provider and platform tests are gated behind `TRENT_TEST_LIVE=1` and the relevant key, and skip
without one. CI (`.github/workflows/ci.yml`) also typechecks, lints, scans the output surfaces for
canned strings, hex colours and emoji, builds the four binaries and runs each on its native OS.

The working rules are in `AGENTS.md` and `CONTEXT.md`: `apps/web/` is read-only; a failing test
comes first; nothing is "done" without executable evidence. Session logs live in `docs/sessions/`.

## Documentation

| Page | Covers |
|---|---|
| [getting-started.md](docs/getting-started.md) | Clone to first real conversation |
| [configuration.md](docs/configuration.md) | Config schema, the yaml/env split, profiles, the env contract |
| [doctor.md](docs/doctor.md) | The 13 checks, exit codes, `--json`, `--fix` |
| [fleet.md](docs/fleet.md) | The catalog, core seats, packs |
| [skills.md](docs/skills.md) | The skills hub and the pre-install scanner |
| [gateway.md](docs/gateway.md) | The eight messaging adapters, pairing, approvals |
| [terminal.md](docs/terminal.md) | Sandbox backends and `trent sandbox build` |
| [desktop.md](docs/desktop.md) | The Tauri v2 app |
| [security.md](docs/security.md) | Egress brokering, redaction, file permissions, approvals |
| [troubleshooting.md](docs/troubleshooting.md) | Failure modes we have actually hit |

## License

MIT. See [LICENSE](LICENSE).
