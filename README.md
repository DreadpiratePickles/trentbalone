# Trent Fleet

Trent is a multi-agent AI cofounder that runs from your terminal. Nine seats (CEO, engineer,
growth, sales, content, support, analyst, finance, escalation) work a task through a real
orchestrator, share one company memory, run their tools inside a sandbox that never sees a real API
key, and improve their own prompts and skills under a human-gated loop. Browsing is a toolset any
seat can use, not a seat of its own. A catalog of 164 further specialists can be installed on top.

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
trent run "<objective>"     # one shot, no terminal: streams the run, exits 0/1/3/6/7/130
trent run - --format stream-json   # objective on stdin, one JSON object per line
trent --tui                 # full-screen Ink TUI on the same session engine
trent --continue            # resume the last conversation
trent doctor                # 22 health checks; exit 3 on a configuration failure
trent fleet list            # 173 agents: 9 core seats plus 164 catalog specialists
trent fleet install <id>    # install a specialist with its tools, skills and model
trent goal create "<obj>" --gate "tests=npm test"   # a goal whose shell gates must exit 0
trent brain status          # the company brain: identity, standing decisions, episodic notes
trent brain import <path>   # md, txt, csv, pdf, docx, xlsx into the brain, chunked; seats cite chunk ids
trent sessions search <q>   # full text over this profile's past transcripts
trent curator status        # skill ages, quarantines and the append-only mutation ledger
trent improve status        # traces, quarantined drafts, last sweep
trent security audit        # read-only report over this profile; exit 1 on a finding
trent approvals list        # everything waiting on a human; approve <id> and reject <id> decide it
trent budget status         # the day's spend by surface, against the caps and the keys to raise
trent cron start            # tick the schedule; trent heartbeat start for the periodic check
trent jobs failed           # failed job runs, newest first; trent jobs retry <id> re-runs one
trent workspace trust       # let this project's AGENTS.md, CLAUDE.md and .trent/*.md reach the prompt
trent hooks list            # hooks configured for this profile; trent hooks consent allows one to run
trent connect <provider>    # stripe, google, square, twilio, buffer, meta, bluesky: tokens to the 0600 secrets file
trent --help                # 35 commands, 151 with their subcommands
```

Add a model key with `trent config set GEMINI_API_KEY <key>` (or `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`). With no key, the REPL still runs but
prints a `DEGRADED` banner and marks every line, because the planner falls back to deterministic
plans and the critic auto-passes. Nothing marked `DEGRADED` came from a model.

`TRENT_QUEUE_FALLBACK=disabled` must be exported for `trent doctor` to pass. The orchestrator sets
it for its own runs; the doctor checks the raw environment. Details in
[docs/configuration.md](docs/configuration.md).

## What you get

- **A 9-seat fleet with 164 optional specialists.** `trent fleet list --json` returns 173 agents:
  ceo, engineer, growth, sales, content, support, analyst, finance and escalation, plus the catalog.
  They are data in the wrapped application, not prompts invented at runtime, and the nine ids are
  exactly the nine roles a plan step can be assigned to. A seat is a capability, not a prompt: its
  toolsets, its approval gates and its per-run cap in integer cents come from the app's own
  `SLOT_ENVIRONMENTS`, and its model tier from `SEAT_MANIFESTS`, so `trent fleet show <seat> --json`
  prints what that seat may do, what it may not, and which of its manifest capabilities this install
  cannot execute at all.
- **Shared fleet memory and cross-agent recall.** One `MEMORY.md`/`USER.md` pair per profile,
  injected into every seat's prelude; completed step outputs from any agent are ranked against the
  current objective and recalled within a character budget; `fleet_search` searches every agent's
  past runs; skills one agent earned are listed and viewable by the others. Recall is hybrid when
  `memory.embedder` resolves a key — lexical TF-IDF blended with an embedding cosine — and lexical
  otherwise, which `trent doctor` reports by making one cheap embedding call. A seat only ever adds
  an entry; rewrites belong to the nightly consolidation, which proposes itemised operations over
  entries by id rather than a rewritten block, and reaches disk only through `trent improve promote`.
  Only two writers exist and both are locked and atomic. See
  [packages/trent-core/src/fleet-memory/README.md](packages/trent-core/src/fleet-memory/README.md).
- **Durable orchestration.** The CLI drives the application's own orchestrator with its own drain
  loop; a run survives a process restart. Approvals, budget and the audit chain persist in a local
  SQLite database at `~/.trent/trent.db`.
- **A REPL that streams the run, and remembers it.** Orchestrator events (run start, step start,
  step output, step end) render as they happen. Ctrl+C aborts the in-flight stream and leaves the
  process alive. A session is a conversation: turns are appended under `~/.trent/sessions/`, the
  last few travel with the next run, `trent --continue` resumes the most recent one with its spend,
  and `trent sessions search <query>` runs full text over every past transcript of the profile.
- **A doctor that fails honestly.** 22 checks; the credentials check makes one cheap authenticated
  call rather than testing for presence. Exit codes are documented in
  [docs/doctor.md](docs/doctor.md).
- **A company brain, and an undo for what an agent wrote.** `<profile>/brain/` holds identity,
  standing decisions and episodic notes as files, versioned with git when it is on PATH; the memory
  blocks migrate into `brain/system/` on first use and every index over it is disposable. Separately,
  every file a seat writes is recorded with its pre-image in a per-run checkpoint ledger, so
  `/checkpoints` lists the turn's writes and `/rollback` puts them back. See
  [docs/brain.md](docs/brain.md) and [docs/checkpoints.md](docs/checkpoints.md).
- **Goals with deterministic gates.** `trent goal create "<objective>" --gate "name=<command>"`
  opens a standing goal whose shell gates must each exit 0 before any judge is consulted; a red gate
  ends the run and its output starts the next attempt. `goals.verify_on_stop` is on by default, so a
  turn that edited code cannot give a final answer without fresh test or build evidence. See
  [docs/goals.md](docs/goals.md).
- **A curator for the skills a seat writes.** Ageing, adoption, quarantine and release, over an
  append-only mutation ledger with an undo, plus a second scan of the whole composed skill after
  every agent write. See [docs/skills.md](docs/skills.md).
- **Scheduled jobs and a heartbeat.** `trent cron start` ticks the profile's schedule every 30
  seconds and delivers each result to a gateway target; `trent heartbeat start` runs the founder's
  `HEARTBEAT.md` checklist against live fleet state on an interval, outside quiet hours, and
  consolidates fleet memory once a day. Both keep run history and a pid lock. See
  [docs/cron.md](docs/cron.md) and [docs/heartbeat.md](docs/heartbeat.md).
- **A concurrent-run cap and a failed-jobs view.** `runtime.max_concurrent_runs` bounds how many
  runs every surface drives at once; `trent jobs failed` lists the failed job rows and
  `trent jobs retry <id>` runs one again, linked to the original. See [docs/jobs.md](docs/jobs.md).
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
| `cron` | `cronjob_manage` | On by default; prompt-injection scan on stored prompts; the same `jobs.json` `trent cron` ticks ([docs/cron.md](docs/cron.md)) |
| `plugins` | `plugins_list` + `~/.trent/plugins/*/plugin.json` commands | On by default; names cannot shadow built-ins, manifests must be 0600 |
| `human` | `ask_human` | On by default; the seat asks the founder and waits, on the durable approval path |
| `memory` | `memory`, `fleet_search`, `fleet_skill_view` | Always on, registered by the fleet-memory hook |
| `browser` | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, ... | Opt-in; needs a Chromium on the machine, drives it through the egress proxy ([docs/browser.md](docs/browser.md)) |
| `vision` | `vision_analyze` | Opt-in; sends the image to the configured model ([docs/browser.md](docs/browser.md)) |
| `mcp` | `mcp_<server>_<tool>`, `mcp_status` | Opt-in; servers from `trent mcp add` (stdio or http), scanned at install time ([docs/mcp.md](docs/mcp.md)) |
| `tools` | `tool_search`, `tool_describe`, `tool_call` | Registered when there is anything to defer; MCP, plugin and app-catalog tools are behind these bridges at any catalog size, everything outside the core toolsets once `tools.disclosure_threshold` (24) is passed ([docs/tools.md](docs/tools.md)) |
| `todo` | `todo` | Always on; the run's task list, durable across a restart, outside the transcript compaction shortens |
| `clarify` | `clarify` | Always on; up to five founder questions in one card, on the same durable path as `ask_human` |
| `session_search` | `session_search` | Always on; full text over this profile's past transcripts (FTS5, lexical fallback), also `trent sessions search <query>` |

`toolsets` accepts thirteen names. Quick setup writes all thirteen; blank-slate setup writes
`file_ops` and `terminal` and puts every other name in `disabled_toolsets`; a `config.yaml` with no
`toolsets` key gets the schema default of nine, which is every row above marked on by default.
The last four rows are not toolsets a founder enables: they are the wrapper's own mechanics and are
registered on every build. Every tool call goes through the approval floors in
`tools/approval-floors.ts` — including one made through `tool_call`, which re-enters the same
wrapper chain a direct call enters; output over 24K characters spills to a file.

## Connect to things

| Surface | Command | State |
|---|---|---|
| Telegram, Discord, Slack, WhatsApp, Signal, email, Teams, Home Assistant | `trent gateway setup <platform>`, `trent gateway start` | Eight adapters on each platform's real protocol, each with a wire test against a local server; live tests skip without credentials. Device pairing is default-deny; approvals are checked against a durable row and can be decided by a reaction on the card; a thread is its own session; a second message on a busy chat queues rather than starting a second turn; push alerts reach the owner. [docs/gateway.md](docs/gateway.md) |
| Agent-to-Agent protocol | `trent a2a serve`, `trent a2a card` | The [A2A specification](https://a2a-protocol.org/latest/specification/) on the wire: the Agent Card at `/.well-known/agent-card.json` (one skill per seat, read from the roster), and JSON-RPC 2.0 at the server root with `message/send`, `message/stream` (SSE), `tasks/get` and `tasks/cancel`. One message is one real orchestration run: the task moves through the spec's `TaskState` (`submitted` -> `working` -> `completed` \| `failed` \| `canceled` \| `input-required`), the run's own summary comes back as an `Artifact` of text `Part`s, and a run parked on an approval settles `input-required` carrying the gate's own question as a `Message`. Errors use the spec's codes (`-32001` unknown task, `-32002` not cancelable, `-32004` unsupported). Bearer auth when `TRENT_A2A_TOKEN` is set, and the card declares it only then. Push notifications, `tasks/resubscribe` and non-text parts are not implemented and say so. The pre-spec `POST /a2a/tasks` payload survives one release behind a `Deprecation` header. `trent serve` is a retired alias that exits 2. [docs/a2a.md](docs/a2a.md) |
| Editors (VS Code, Cursor, Zed) | `trent acp` | The [Agent Client Protocol](https://agentclientprotocol.com/) over stdio, which is what an editor spawns: newline-delimited JSON-RPC on stdin and stdout with `initialize` (protocol version 1), `session/new`, `session/prompt` and `session/cancel`. One prompt is one real orchestration run, streamed back as the protocol's `session/update` notifications, and the turn ends with a real `stopReason` — `cancelled` when the editor cancels, and a JSON-RPC error carrying the run's own reason when it fails. `loadSession`, image and audio blocks, and the client-side `fs/*` and `terminal/*` methods are not implemented. `trent acp --http` keeps the older JSON-RPC-over-HTTP server (default port 7890) for existing integrations. [docs/a2a.md](docs/a2a.md) |
| MCP connectors | `trent mcp list\|add\|remove\|test` | Stdio and http servers; `add` scans every tool description at install time and refuses a finding unless `--allow-flagged`; tool results are scrubbed of secrets. [docs/mcp.md](docs/mcp.md) |
| Web UI | `trent web`, `trent web --start` | `trent web` reports readiness; `--start` serves the real UI from `apps/web/.next/standalone` on loopback, deriving a 0600 per-profile `AUTH_SECRET` the way the desktop app does, and polls `/` before it reports the port. It refuses in exactly one case: the standalone tree is not built and `--build` was not passed ([docs/getting-started.md](docs/getting-started.md)) |
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

The sweep also runs unattended. With `heartbeat.sweep.enabled` on — opt-in, false by default — a
heartbeat tick runs at most one sweep every `heartbeat.sweep_interval_hours`, never inside quiet
hours, and only while the day's ledger still holds `improve.sweep_cap_cents` under
`budget.daily_cap`; `trent heartbeat sweep` runs the same builder once by hand. Nothing it produces
is promoted: drafts land in quarantine and `trent improve promote` is still the only way out.
Tool descriptions improve on the same path: tool-health signals become gated proposals that
`trent improve tools` lists and the same promote gate decides. Retrieval has a number too:
`trent improve retrieval` prints recall@8 of the shipped ranker over the promoted retrieval goldens
(added with `trent improve goldens add --retrieval`, or captured when a seat reads a ranked chunk)
and exits 1 under `retrieval.min_recall`; the sweep grades the same number first, and the ranking
files are frozen against its drafts ([docs/improve.md](docs/improve.md)).

The judge is no longer the executor. `improve.judge_model` resolves a planner-tier model and a judge
equal to the executor is a configuration error naming both; on a single provider key the two still
come from one model family, which plan decision 6 records as the limit until a second key exists.

Not done: tree search, an offline reward model for seats without a verifier, and weighting the judge
by the judge-versus-human agreement ledger (the ledger exists; the weighting does not). `trent cron`
schedules prompts, not sweeps.

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
- **Autonomy levels, deny globs and a hardline blocklist.** `autonomy` (`ask_always`,
  `ask_dangerous` the default, `never`) decides how often a human is asked and nothing else: no
  level lifts the shipped blocklist, an `approvals.deny` glob, or a floor marked
  never-auto-approvable. [docs/security.md](docs/security.md#autonomy-levels).
- **User hooks that only run after consent.** Each hook is an argv array, never a shell string, and
  runs only once `trent hooks consent` has recorded a hash of its exact spec; editing the argv,
  timeout or match filter loses the consent. [docs/security.md](docs/security.md#user-hooks).
- **Provenance on every tool result.** The `web`, `browser`, `mcp` and `plugins` toolsets — and any
  delegated child that used them — mark a step `untrusted`. A `memory` write from such a step is
  held as a pending approval instead of written and carries `[provenance: untrusted via <tools>]`
  once approved; `skill_manage` from one is refused. `trent approvals list` shows both kinds of
  waiting row — a parked run step and a held memory write — and `approve <id>` / `reject <id>`
  decide either without knowing which file it lives in.
  [docs/security.md](docs/security.md#provenance-and-untrusted-context).
- **One read-only report over the whole profile.** `trent security audit` walks autonomy,
  approvals, hooks, egress, workspace trust, redaction, MCP, plugins, the audit chain, file
  permissions and `config.yaml` for credential-shaped values, writes nothing, and exits 1 on a
  finding. [docs/security.md](docs/security.md#auditing-a-profile).
- **Policy rules over tool sequences.** Every tool call is classified and a rule list is evaluated
  against the run's recent history at dispatch, so "read a secret, then send a message" is denied
  before the second call runs. [docs/security.md](docs/security.md#policy-rules).
- **Prompt redaction.** With `privacy.redact_prompts: true`, secrets and PII are replaced by
  numbered tokens before a prompt reaches a provider, and the same token map restores them in the
  reply. [docs/security.md](docs/security.md#prompt-redaction).
- **Signed audit export.** `trent audit export` writes the store's hash-chained audit rows as
  NDJSON with a detached Ed25519 signature; `trent audit verify` re-walks the chain and checks the
  signature without a database. [docs/security.md](docs/security.md#signed-audit-export).

Known, reported and not fixed defects in the wrapped application are listed in
[docs/security.md](docs/security.md).

## Contributing and tests

Measured on 2026-09-15 on this branch (`feature/trent-fleet-v2`):

```
npx vitest run --reporter=dot
  Test Files  180 passed | 2 skipped (182)
       Tests  1765 passed | 27 skipped (1792)
```

That covers `packages/` and `apps/cli/`. The wrapped web app has its own suite: `npm run test:web`.
Live provider and platform tests are gated behind `TRENT_TEST_LIVE=1` and the relevant key, and skip
without one; the durable-store suites run under Bun as child processes and skip without it. CI (`.github/workflows/ci.yml`) also typechecks, lints, scans the output surfaces for
canned strings, hex colours and emoji, builds the four binaries and runs each on its native OS.

The working rules are in `AGENTS.md` and `CONTEXT.md`: `apps/web/` is read-only; a failing test
comes first; nothing is "done" without executable evidence. Session logs live in `docs/sessions/`.

## Documentation

| Page | Covers |
|---|---|
| [getting-started.md](docs/getting-started.md) | Clone to first real conversation |
| [configuration.md](docs/configuration.md) | Config schema, the yaml/env split, profiles, the env contract |
| [doctor.md](docs/doctor.md) | The 22 checks, exit codes, `--json`, `--fix` |
| [fleet.md](docs/fleet.md) | The catalog, core seats, packs, agent versions with promote and rollback, export and import |
| [skills.md](docs/skills.md) | The skills hub, the pre-install scanner and the curator |
| [tools.md](docs/tools.md) | The toolsets, progressive disclosure, and the todo, clarify and session-search tools |
| [brain.md](docs/brain.md) | `<profile>/brain/`: the truth rule, migration, signposts and recall |
| [checkpoints.md](docs/checkpoints.md) | The agent-write ledger, per-turn checkpoints and `/rollback` |
| [goals.md](docs/goals.md) | Standing goals, shell quality gates and `goals.verify_on_stop` |
| [improve.md](docs/improve.md) | Gates, goldens, the judge model, promotion and rollback |
| [a2a.md](docs/a2a.md) | The A2A specification on the wire, and ACP over stdio for editors |
| [gateway.md](docs/gateway.md) | The eight messaging adapters, pairing, approvals and reaction decisions, push alerts, threads as sessions, double texting |
| [cron.md](docs/cron.md) | `trent cron`: the schedule file, the runner, run history, delivery |
| [heartbeat.md](docs/heartbeat.md) | `trent heartbeat`: `HEARTBEAT.md`, quiet hours, memory consolidation, history and the lock |
| [jobs.md](docs/jobs.md) | The concurrent-run cap, `trent jobs failed` and `trent jobs retry` |
| [mcp.md](docs/mcp.md) | `mcp_servers` config, the CLI, the install-time scan, result scrubbing |
| [browser.md](docs/browser.md) | The browser and vision toolsets |
| [terminal.md](docs/terminal.md) | Sandbox backends and `trent sandbox build` |
| [desktop.md](docs/desktop.md) | The Tauri v2 app |
| [security.md](docs/security.md) | Egress brokering, sandbox, file permissions, signed audit export, log and prompt redaction, approvals, policy rules |
| [troubleshooting.md](docs/troubleshooting.md) | Failure modes we have actually hit |

## License

MIT. See [LICENSE](LICENSE).
