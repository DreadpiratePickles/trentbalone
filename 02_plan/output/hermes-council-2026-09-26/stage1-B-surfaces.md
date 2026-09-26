# Stage 1, Reviewer B: surfaces, operations and developer/user experience

Question (Bobby): "Audit what Trent has done so far, where it is lacking, and where it must really look
to be as good as and surpass Hermes Agent." Lens: install, CLI, REPL, TUI, desktop, web, gateway,
daemons, webhooks, browser attach, MCP/A2A/ACP, exports, config, docs, observability, release.

- **Trent:** HEAD `79fa451` (`feature/trent-fleet-v2`) plus the uncommitted tree (S2, H3, H5, L1, S3,
  P3). Each row says "HEAD" (landed) or "tree" (built, not landed).
- **Hermes:** the local checkout `/Users/bobbymeher/.hermes/hermes-agent`, `pyproject.toml` version
  0.21.3, git `49eb7b5dba` (2026-09-20, `v2026.8.27-13607`). It is older than the inventory's v0.21.4.
  Paths below are relative to that checkout.
- **Commands run.** Every CLI probe used `env -u <provider keys> TRENT_HOME=<scratch> npx tsx
  apps/cli/src/index.ts ...`, stdin `/dev/null`, one command at a time. Nothing bound a port or called
  a model. The scratch homes live in this session's scratchpad.

| Probe | Exit | Result |
|---|---|---|
| `--help` | 0 | 36 commands. A walk of `COMMAND_SPECS`: 37 top-level (one hidden), 105 second-level, 11 third-level |
| `run "<obj>" --dry-run` | 0 | Prints nothing at all in text mode |
| `run "<obj>" --dry-run --json` | 0 | Echoes the parsed options only; provider, model, mode and budget are not resolved |
| `doctor --json` | 3 | total 23: ok 10, warn 5, fail 1, skip 7. The credentials fix says `config set GEMINI_API_KEY` although Ollama is up on this machine |
| `setup --mode quick --json` (keyless) | 3 | Valid JSON, `reason: no-key`; guidance goes to stderr. No local runtime is offered |
| `setup --mode local --dry-run --json` | 0 | Found Ollama 0.32.9 and `qwen3.5:9b`; would write provider ollama, agent.mode solo. It probed `127.0.0.1:11434` and `:1234` |
| `gateway status --json` | 0 | 12 platforms, 0 configured |
| `service install --dry-run --json` | 0 | launchd plist: `RunAtLoad`, `KeepAlive`, ThrottleInterval 30. Program is `node + tsx` (node-entry) |
| `desktop status --json` | 5 | `updater.release: release lookup returned HTTP 404` |
| `desktop status --no-check --json` | 0 | `installed: false` |
| `tools list --json` | 2 | JSON error envelope: no such subcommand (`tools --json` exits 0) |
| `config set nonexistent.key 1 --json` | 0 | `written: true`; the key lands in `config.yaml` |
| `mcp add demo --url https://… --dry-run --json` | 0 | Dry-run report |
| `gateway setup line --dry-run --json` (tree) | 0 | Reads `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` |

All 25 probes run with `--json` printed valid JSON on stdout, errors included.

Other checks:
- `curl -w '%{http_code}'` on the installer URLs: `agent.let-trent.uk/install.sh` returned **404**;
  `hermes-agent.nousresearch.com/install.sh` returned **200**.
- `gh run list`: the last 6 CI runs on the branch succeeded. `gh release list` is empty and
  `git ls-remote --tags` returns 0 tags.
- A throwaway `npx tsx` script checked every `trent <cmd> <sub>` in `README.md` and `docs/*.md`
  against `COMMAND_SPECS`. It flagged 3 references.
- Not run, per the brief: the vitest suite, the REPL (it starts the egress listener), `gateway start`,
  `web --start`, any keyed or keyless `trent run`.

## 1. Summary verdict

1. **The messaging gateway cannot admit anyone.** Every unknown sender is told to have an operator
   run `trent gateway pair <platform> <code>` (`GatewayManager.ts:327`). That command does not exist
   and never did (`git log -S'name: "pair'`: empty). So all 12 adapters, chat approvals and voice notes
   are unreachable unless someone hand-edits `gateway.json`.
2. **At HEAD, webhook-only adapters never listen.** No production code constructs the
   `WebhookServer` (`git grep "WebhookServer" HEAD`). WhatsApp Cloud, LINE, Home Assistant, Slack
   Events mode and Telegram webhook mode therefore receive nothing. H3 and P3 in the tree fix this;
   they have not landed.
3. **Nothing is installable.** 0 tags, 0 releases, and the installer URL returns 404. Hermes has a
   live installer (200), 29 tags, install end-to-end tests on 3 OSes, a Docker image and Nix.
4. **Interaction depth is far behind.**
   - Slash commands: 21 against 102.
   - No token streaming on any surface. A local 9B model shows nothing for minutes.
   - TUI: 1,448 lines against 43k.
   - Desktop: a 2.4k-line Tauri shell around a *different app*, against a 380k-line Electron client
     plus a 51k-line dashboard.
5. **The keyless path works but first run never offers it.** `setup --mode local` found Ollama and a
   9B model here; keyless quick setup and doctor never mention it. Hermes mints a guest free tier.
6. **Operations are partial.**
   - `service install` supports launchd and systemd only.
   - Installed from Node, it silently runs a non-durable store.
   - There is no `logs`, `send`, `backup`, `profile`, `pairing` or `webhook` command.
7. **Ahead on the scripting and audit contract.** Global `--json` and `--dry-run` (25 of 25 probes
   valid), documented exit codes, one spend ledger with caps, a signed hash-chained audit export, and
   agent export to Claude Code, Codex and Hermes.
8. **Docs are honest in method but not in coverage.** The docs-truth test checks 4 of 31 pages and
   skips "Not yet implemented" sections by design. 3 of the 14 disagreements in §5 sit
   in those sections.
9. **Protocols are mixed.**
   - At parity: MCP server, A2A (v1.0 and 0.3.0) and MCP OAuth 2.1.
   - Behind: ACP, which refuses every held call and cannot load a session.
   - Broken for remote servers: `mcp add` and `mcp test` cannot reach http servers, so their
     install-time scan never runs.
10. **Verdict: behind on surfaces and operations.** Fix pairing, land H3+P3, route keyless users to
    local, stream tokens and cut a tag before building any new surface.

## 2. Area by area

"tree" means built but not landed. Hermes paths are relative to its checkout; Trent's `core/` is
`packages/trent-core/src/` and `cli/` is `apps/cli/src/`.

| Area | Hermes | Trent | Verdict | Evidence |
|---|---|---|---|---|
| One-line install | Installer of 3,949 lines, URL 200; `install.ps1`, `install.cmd`; Termux | Installer of 697 lines verifying signed SHA256SUMS; URL 404; 0 tags | **behind** (Bobby-gated) | H: `scripts/install.sh`, `.github/workflows/install-e2e*.yml`. T: `scripts/install.sh:43-45`, `.github/workflows/release.yml`, `pages.yml` |
| Binaries and packaging | Docker (`Dockerfile`, `docker.yml`), Nix (`flake.nix`, `nix.yml`), 29 tags | 4 Bun binaries built and executed on 4 OSes in CI; no Docker image, Nix or brew | **behind** | H: `.github/workflows/docker.yml`, `nix.yml`. T: `.github/workflows/binary.yml:111-160` |
| Supply chain | OSV scanner and supply-chain audit workflows | Dual signature (minisign and ECDSA) over SHA256SUMS; never run; no dependency audit | **behind** (design ahead, unexercised) | H: `.github/workflows/osv-scanner.yml`, `supply-chain-audit.yml`. T: `release.yml:9,155-180` |
| Setup and first run | Quick setup; guest free tier minted at boot | quick, full, blank-slate and local; honest exit 3 when keyless; local detection with an "expectation" line; never offered to a keyless user | **behind** on onboarding, parity on local detection | H: `hermes_cli/free_tier_bootstrap.py`, `anon_sign_in.py`, `setup_quick.py`. T: `core/setup/QuickSetup.ts:36-61`, `detect.ts:108-127`, `local-setup.ts` |
| Doctor | 8 doctor modules, live and connectivity checks | 23 checks with fix hints, exit 3; Local Model check with a tool-call smoke test | **parity** | H: `hermes_cli/doctor*.py`. T: `core/doctor/checks/` (26 files), probe `doctor --json` |
| CLI breadth | 62 subcommand modules plus kanban, send and projects | 36 commands, 152 with subcommands | **behind** on breadth | H: `hermes_cli/subcommands/`. T: `cli/commands/index.ts` |
| CLI scripting contract | `--json` in 7 of 62 modules, `--dry-run` in 10 | Global `--json` and `--dry-run`, a JSON error envelope, run exit codes 0/1/3/5/6/7/130, `--format stream-json` | **ahead** | T: `cli/commands/groups/run.ts:167-170`, 25 probes |
| REPL | 102 slash commands, `!` shell, completion, `/steer`, `/queue`, `/retry`, `/undo`, `/title`, `/compress`, token streaming with a reasoning preview | 20 table commands plus `/stop`; turn queue and double-text policy; y/n approval card; `-c`; whole answers only | **behind** | H: `hermes_cli/commands.py` (102 `CommandDef`), `cli_stream_mixin.py`, `bang_shell.py`, `subcommands/completion.py`. T: `cli/repl/commands.ts`, `engine.ts:328-365`, `render.ts:201-208` |
| Token streaming | Streams to the CLI; streaming edits on Telegram, Slack and WeCom | None. The 20 frozen event kinds carry whole outputs ("no surface may be taught a new one") | **behind** | T: `core/solo/events.ts:1-24`, `cli/repl/render.ts` |
| TUI | Ink TUI, 43,407 lines, session switcher | Ink TUI, 1,448 lines, 5 modals, fleet only | **behind** | H: `ui-tui/src`. T: `cli/tui/`, `docs/solo.md:22` |
| Desktop | Electron app (~380k lines); panes, terminal, HUD, Bot Screen; bootstrap installer | Tauri shell (2,423 lines) showing the wrapped Next.js app; `signingIdentity` null; never packaged | **behind** | H: `apps/desktop/src`, `apps/desktop/electron`, `apps/bootstrap-installer`. T: `apps/desktop/src-tauri/src/`, `docs/desktop.md` |
| Web UI | A dashboard over sessions, cron, gateway, MCP, memory, profiles, pairing and config (51k lines of web plus server routes) | `trent web --start` runs the wrapped app; the child env points it at no profile store, ledger or egress, so CLI runs, approvals, spend, cron and gateway are invisible there | **behind** | H: `web/src`, `hermes_cli/web_server_*.py`. T: `cli/commands/web-server.ts:257-269` |
| Messaging platforms | 22 plugins (SMS, iMessage via Photon or BlueBubbles, Google Chat, IRC, SimpleX, CN ×3) plus 6 core adapters (3 more CN) | 12: Telegram, Discord, Slack, WhatsApp Cloud, Signal, email, Teams, Home Assistant, Matrix, Mattermost, LINE, ntfy | **behind** | H: `plugins/platforms/`, `gateway/platforms/`. T: `core/gateway/registry.ts:40-110` |
| Pairing and allowlists | `hermes pairing list/approve/revoke/clear-pending`; `*_ALLOWED_USERS` | `PairingManager.pair/grant/revoke` exist with **no caller** outside tests; no allowlist; approvals need a paired admin | **behind, blocking** | H: `hermes_cli/subcommands/pairing.py:10-28`. T: `core/gateway/security/PairingManager.ts:5,119`, `GatewayManager.ts:327`, `ApprovalBridge.ts:180` |
| Webhook-inbound adapters | Shared ingress, relay connector, webhook adapter | HEAD: no listener. Tree (H3+P3): listener opens for webhook-only adapters. No tunnel or relay | **behind** at HEAD | H: `gateway/platforms/shared_ingress.py`, `gateway/relay`. T: `git grep WebhookServer HEAD`; `cli/commands/groups/servers.ts` [P3] hunks |
| Chat features | Threads, reactions, voice in and out, `/steer`, tool-progress bubbles, delivery ledger, home channel, `hermes send` | Threads (Matrix, Mattermost, Slack), reaction approvals bound to row and nonce, local voice-note transcription, double-text queue, `gateway.owner` cards; no TTS, progress, send or ledger | **partial**, all gated by pairing | T: `core/gateway/ApprovalBridge.ts`, `voice-notes.ts`, `ConversationQueue.ts`; `docs/gateway.md` |
| Signed webhook routes | Routes plus `hermes webhook subscribe/list/remove/test` with hot reload | Tree (H3): HMAC, Stripe and GitHub signatures, 24 h dedupe, untrusted provenance, cost cap, deliveries log; config only, no CLI | **parity in tree**; ahead on provenance; behind at HEAD | H: `hermes_cli/subcommands/webhook.py:10-57`. T: `core/webhooks/` (untracked), `docs/webhooks.md` |
| Service | systemd, launchd, Windows (1,783 lines) and s6; `gateway start/stop/restart/install` | `service install/uninstall/status/daemon`, launchd and systemd; Windows is a schtasks hint; under Node the daemon runs `EphemeralStore` with no warning | **partial** | H: `hermes_cli/service_manager.py:14`, `gateway_windows.py`. T: `core/service/install.ts:155`, `program.ts:78-90`, `cli/runtime/headless.ts:237-239` |
| Cron and heartbeat | Natural-language schedules, skill jobs, chaining | Five-field cron or `@aliases`, `--model` pin, incidents, quota hold, quiet hours | **partial** | T: `cli/commands/groups/cron.ts:257-261` |
| Browser attach | CDP attach to the real profile with consent; Browserbase and Browser Use | Tree (H5): CDP attach behind per-action bound approvals, password-field refusal, hash-chained audit | **ahead on safety once landed**; unlanded | H: `hermes_cli/browser_connect.py:1-6`, `plugins/browser/`. T: `core/tools/browser/attach*.ts` (untracked) |
| MCP client | 65 presets, OAuth, security scan | OAuth 2.1 landed (`2095c7d`); 9-entry gallery; `add` and `test` cannot reach http servers, so no scan at add | **partial** | H: `optional-mcps/` (65), `hermes_cli/mcp_security.py`. T: `apps/web/lib/mcp-connector-catalog.ts`, `docs/mcp.md:75-77,189-190` |
| MCP server | `mcp_serve.py` | stdio or Streamable HTTP, bearer, `needs_approval` | **parity** | T: `core/mcp-server/` |
| A2A | In and out | v1.0 and 0.3.0 server; client tools behind the gate; Hermes calls it | **parity** | T: `core/a2a/v1.ts`, `core/tools/a2a/` |
| ACP | `request_permission` for commands and edits; session load and resume | `loadSession: false`; every held call refused | **behind** | H: `acp_adapter/permissions.py:78-141`, `edit_approval.py`, `session.py`. T: `core/acp/stdio.ts:167`, `docs/solo.md` |
| Exports | Imports from Claude Code and Codex; exports only its own profiles | Export and import with Claude Code, Codex and Hermes | **ahead** | T: `core/fleet/export-{claude,codex,hermes}.ts`, `import-*.ts` |
| Config | `config check/migrate/edit/path`; unknown sub-key fails with "did you mean" | `config get/set/unset/list`; the root schema passes unknown keys (`config set nonexistent.key 1` exits 0) | **partial** | H: `hermes_cli/config.py:3193`. T: `core/config/schema.ts:231`, probe |
| Docs | Website plus per-plugin pages | 31 pages plus an index; proof comments; docs-truth over 4 pages; 14 disagreements (§5) | **behind** on breadth, **ahead** on method | T: `docs/README.md`, `cli/commands/__tests__/docs-truth.test.ts:35` |
| Observability | `hermes logs` with filters, insights, shared metrics, dump and debug bundles | OTLP with gen_ai conventions, `usage --by`, `budget status`, signed `audit export/verify`; no logs command, no support bundle | **ahead** on spend and audit, **behind** on logs | H: `hermes_cli/logs.py:1-5`, `dump.py`, `debug.py`. T: `core/traces/OTelExporter.ts`, `cli/commands/groups/usage.ts`, `audit.ts` |
| Update | `hermes update` with receipts and rollback | `trent update --check/--rollback/--channel` with signature checks; nothing to fetch | **partial** (Bobby-gated) | T: `core/updater/selfUpdate.ts` |
| Profiles and backup | `profile create/clone/export/import/install`, `backup` | `--profile` selects a directory; nothing else | **behind** | H: `hermes_cli/subcommands/profile.py:14-160`, `backup.py`. T: `core/config/ConfigManager.ts` |
| CI | 35 workflows incl. install e2e, desktop e2e, docs-site checks | 5 workflows; last 6 runs green; installer render guard | **parity** on gating, **behind** on install and desktop e2e | T: `.github/workflows/ci.yml:297-321` |

## 3. The ten most important gaps, ranked

**1. A messaging user can never be paired, so the gateway admits no one. Size: S.**
- **Why it matters.** A shop owner texts the bot and gets "An operator can approve it with: trent
  gateway pair telegram ABCD1234". That command answers `unknown command`. Chat approvals need a
  paired admin (`ApprovalBridge.ts:180`), so answering approvals from a phone, voice notes and
  double-text handling are all unreachable too. The only workaround is hand-editing `gateway.json`.
- **Hermes bar:** `hermes_cli/subcommands/pairing.py` (`pairing list/approve/revoke/clear-pending`),
  plus `*_ALLOWED_USERS` allowlists (inventory §1.3).
- **Trent files:**
  - `apps/cli/src/commands/groups/servers.ts`: add `gateway pair <platform> <code> [--admin]`,
    `gateway pairings`, `gateway revoke`, calling `GatewayManager.getPairing()`.
  - `core/gateway/GatewayManager.ts:327` (message text).
  - `docs/gateway.md:61`.
  - Optionally, `gateway.owner` pre-granted as admin in its own channel.
- **Acceptance test:** a test drives the real `GatewayManager` with a fake Telegram. An unknown
  sender gets code X; `trent gateway pair telegram X --admin --json` exits 0; the sender's next
  message reaches the agent handler; that sender's reaction decides an approval card.

**2. Webhook-only platforms have no listener at HEAD, and there is no public ingress. Size: S to land, M for a relay.**
- **Why it matters.** WhatsApp Cloud and LINE are the channels a mom-and-pop user asks for first.
  At HEAD nothing ever serves `/webhooks/<platform>`. `gateway setup <platform>` also writes
  `<PLATFORM>_BOT_TOKEN`, a name WhatsApp, LINE, email and ntfy never read (HEAD `servers.ts:102`).
- **Hermes bar:** `gateway/platforms/shared_ingress.py`, the `gateway/relay` connector, the
  `gateway/platforms/webhook.py` adapter.
- **Trent files:** land H3 (`core/webhooks/`, `servers.ts`) and P3 (`gateway-setup.ts`, the
  webhook-only listener). Then add `gateway expose` or a documented tunnel recipe that prints the
  public URL to paste into Meta or LINE.
- **Acceptance test:** with only `LINE_CHANNEL_*` set and no `gateway.webhooks` route, `gateway
  start` accepts a correctly signed POST to `/webhooks/line` and 401s a forged one.

**3. No token streaming on any surface. Size: M.**
- **Why it matters.** L0-2 measured a 91 s time-to-first-token and 3 tok/s on this machine's 9B
  model. The REPL, the TUI and chat all show nothing until the step ends, so a local user sees a
  frozen screen for minutes. Hosted users wait too.
- **Hermes bar:** `hermes_cli/cli_stream_mixin.py` (streaming, reasoning preview, tool progress);
  Telegram and Slack streaming edits (inventory §1.3).
- **Trent files:**
  - `core/orchestrator/types.ts`: one additive `step_delta` kind (the "20 kinds" rule has to give way).
  - `core/solo/turn.ts`, `core/solo/events.ts`.
  - `cli/repl/render.ts`, `cli/tui/Chat.tsx`.
  - Gateway adapters: typing indicator, or an edited progress message where the platform supports it.
- **Acceptance test:** in solo mode against a fake OpenAI-compatible server that emits 50 deltas
  100 ms apart, the REPL renders its first answer text within 300 ms of the first delta and before
  `step_end`.

**4. A keyless first run is not routed to the local model that is already there. Size: S.**
- **Why it matters.** On this machine Ollama is up with a tool-capable 9B pulled. Yet keyless
  `setup --mode quick` says "Set OPENAI_API_KEY", and doctor says `config set GEMINI_API_KEY`. The
  guidance names `--mode quick --provider ollama` (`detect.ts:124`), not the newer `--mode local`.
  Hermes users start with zero credentials.
- **Hermes bar:** `hermes_cli/free_tier_bootstrap.py`, `anon_sign_in.py`, `setup_quick.py`.
- **Trent files:** `core/setup/QuickSetup.ts:53-61` (probe `createLocalRuntime()` before aborting),
  `core/setup/detect.ts:108-127`, `core/doctor/checks/credentials.ts`, and first-run
  `cli/commands/index.ts`.
- **Acceptance test:** with no key and a fake Ollama on loopback listing a `tools` model, `trent
  setup --json` exits 3 with `suggested: "local"` and the exact `trent setup --mode local` line, and
  doctor's API Credentials fix hint names the same command.

**5. Nothing a stranger can install. Size: S (Bobby-gated), then M.**
- **Why it matters.** The README's one-liner 404s, there is no tagged release, and there is no
  Docker image for a VPS user.
- **Hermes bar:** `scripts/install.sh`, `.github/workflows/install-e2e.yml` with its macOS and
  Windows runs, `docker.yml`, `nix.yml`, 29 tags.
- **Trent files:** a `v1.0.0` tag (Bobby, per `05_release/output/release-checklist-v1.md`); a new
  install-e2e job in `.github/workflows/release.yml`; a root `Dockerfile` for `trent service daemon`
  on Bun; an OSV or `npm audit` job in `ci.yml`.
- **Acceptance test:** a post-release job runs the published `install.sh` and `install.ps1` on clean
  macOS, Linux and Windows runners and asserts that `trent --version` equals the tag.

**6. The always-on service is silently non-durable, Linux/mac only, and has no controls. Size: S, plus M for Windows.**
- **Why it matters.** `service install` run through the README's Node alias writes a plist that
  launches `node + tsx`. The daemon then keeps parked approvals and runs in `EphemeralStore`
  (`headless.ts:237-239`), and nothing warns. The plist also pins the node path found at install
  time, which here was Hermes's private `~/.hermes/node/bin/node`. There is no
  `service start/stop/restart/logs` and no Windows unit.
- **Hermes bar:** `hermes_cli/service_manager.py:14` (systemd, launchd, Windows, s6),
  `gateway_windows.py`, `gateway start|stop|restart|status`.
- **Trent files:** `core/service/install.ts`, `core/service/program.ts`,
  `cli/commands/groups/service.ts`, `docs/service.md`.
- **Acceptance test:** under Node, `service install --dry-run --json` reports `durable: false` and
  exits 3 unless `--allow-ephemeral`. Under Bun or the binary it reports `durable: true`.
  `service logs -n 20` prints the last 20 lines of `service.log`.

**7. The REPL is a thin shell next to Hermes's. Size: M.**
- **Why it matters.** Missing: `/new`, `/retry`, `/undo` (conversation), `/title`, `/compact`,
  `/usage`, `/steer`, `@file` references, a `!cmd` shell escape, and shell completion for 36
  commands and 152 subcommands. Solo sessions also do not compact until S3 lands (`docs/solo.md`).
- **Hermes bar:** `hermes_cli/commands.py` (102 `CommandDef`), `bang_shell.py`,
  `subcommands/completion.py`, `commands_completion.py`.
- **Trent files:** `cli/repl/commands.ts`, `cli/repl/engine.ts`, a new
  `cli/commands/groups/completion.ts`, and `core/workspace-context/` (scan `@file` content like
  instruction files).
- **Acceptance test:** `/retry` resubmits the last objective as a new run id. `@README.md` inlines
  the file only after the injection scan passes. `trent completion zsh | zsh -n` exits 0 and
  completes `trent gateway <TAB>`.

**8. Editors cannot approve anything over ACP. Size: M.**
- **Why it matters.** In Zed or VS Code every held call is refused rather than asked, and a session
  cannot be reopened (`loadSession: false`, `acp/stdio.ts:167`).
- **Hermes bar:** `acp_adapter/permissions.py:78-141` (`request_permission` with a timeout
  auto-deny), `acp_adapter/edit_approval.py`, `acp_adapter/session.py`.
- **Trent files:** `core/acp/stdio.ts`, `core/solo/holds.ts` (a park hook that sends
  `session/request_permission`), `docs/a2a.md`.
- **Acceptance test:** over ACP stdio, a held `write_file` emits `session/request_permission`;
  `allow_once` runs exactly that call once; `session/load` of an earlier session replays its
  messages.

**9. Operator CLI gaps a real deployment hits in week one. Size: M.**
- **Why it matters.** Missing today:
  - no `trent logs` (logs live in `<profile>/logs/*.log`);
  - no `trent send` (test a channel without a run);
  - no `backup/restore` or `profile create/clone/export/import` (move to a new laptop, one profile
    per client);
  - no `webhook add/list/test` (routes are YAML only);
  - no `config check`: unknown keys pass silently (`schema.ts:231`);
  - `mcp add/test` cannot reach http servers, so `scanRan: false` forever (`docs/mcp.md:189-190`).
- **Hermes bar:** `hermes_cli/logs.py`, `send_cmd.py`, `backup.py`,
  `subcommands/profile.py:14-160`, `subcommands/webhook.py:10-57`, `config.py:3193`.
- **Trent files:** new `cli/commands/groups/{logs,send,profile,backup,webhook}.ts`,
  `core/config/schema.ts`, and `core/tools/mcp/client.ts` (start the egress proxy for
  `add`/`test`, as the REPL does).
- **Acceptance test:** `trent config set modle x` exits 3 with "did you mean model".
  `trent mcp add <http server> --json` against a local fake MCP server returns `scanRan: true`.
  `trent profile export acme` produces an archive that contains no `.env` or token file.

**10. Web and desktop are a different product, not a Trent client. Size: L.**
- **Why it matters.** A non-terminal user (the social manager) opening `trent web` or the desktop
  app sees the wrapped app on its own store. None of the CLI profile's runs, approvals, spend,
  sessions, gateway or cron are there (`web-server.ts:257-269` sets no profile, store or egress).
  The desktop is also unsigned and never packaged.
- **Hermes bar:** `web/src` plus `hermes_cli/web_server_{sessions,cron,gateway,mcp,memory,profiles}.py`;
  `apps/desktop/electron/main.ts` (signed installers).
- **Trent files:** a new `core/api-server/` (loopback REST over the same stores), a thin page in the
  desktop splash or a new `apps/console/`, `apps/desktop/src-tauri/tauri.conf.json` (signing).
- **Acceptance test:** an approval parked by `trent run` in profile P appears in `trent web --start
  --profile P`, and approving it there resumes that run with the same run id.

## 4. Where Trent is genuinely ahead

1. **A scripting contract Hermes does not have.**
   - Every command takes `--json` and `--dry-run` globally; 25 of 25 probes returned valid JSON,
     errors as `{"error":{code,operation,message}}`.
   - `trent run` documents distinct exits (0, 1, 3, 5, 6, 7, 130) and `--format stream-json`.
   - Hermes defines `--json` in 7 of its 62 subcommand modules (`grep -rl '"--json"'
     hermes_cli/subcommands`).
2. **Spend you can cap and query from any surface.** Integer-cent ledger, `trent usage --by
   surface|seat|model|provider|tool`, `trent budget status`, and `run --max-cost-cents` exiting 6
   (`core/governance/spend-ledger.ts`, `cli/commands/groups/usage.ts`, probes exit 0).
3. **A verifiable audit export.** `trent audit export|verify|key`, Ed25519-signed and hash-chained
   (`core/audit/signing.ts`, `docs/security.md:131-141`). Hermes has no equivalent in the inventory
   or the checkout's command list.
4. **Agents that leave for other harnesses.** Export and import with Claude Code, Codex and Hermes
   (`core/fleet/export-*.ts`, `import-*.ts`, live Hermes proof in
   `docs/sessions/2026-09-20-w5-hermes-codex-export.md`).
5. **Safer inbound automation, once landed.**
   - H3 routes mark their runs `untrusted`, carry a cost cap and dedupe for 24 h across restarts.
   - A seeded webhook run's first send parks on send-after-untrusted
     (`docs/sessions/2026-09-26-h3-webhooks.md`, S2 seams).
   - Hermes's webhook routes carry no provenance taint.
6. **Safer browser attach, once landed.** H5 binds each click or type to one approval and refuses
   password and one-time-code fields. That test caught a real "hunter2" typed into a real password
   field (`docs/sessions/2026-09-26-h5-browser-attach.md`). Hermes attaches with a consent path only
   (`hermes_cli/browser_connect.py`).
7. **Local setup that tells you what to expect.** `setup --mode local --dry-run --json` returns
   memory tier, runtimes, model roles (it flags abliterated 27Bs as "chat, no tools"), picks and an
   expectation sentence, all without writing (probe above).
8. **Docs with receipts.** A proof comment per README claim and a docs-truth test reading
   `COMMAND_SPECS`, the schema, the REPL table and `DEFAULT_CHECKS`. The mechanism is ahead; the
   coverage is not (§5).

## 5. Claims not verified, and help or docs that disagree with behaviour

1. **`README.md:28` and its proof comment.** It says a keyless run "exits 1". Code returns 5 when a
   provider refuses the run's calls (`cli/commands/groups/run.ts:170`), and `trent run --help` lists
   "5 provider failure". The same commit (`ac9a0e3`) introduced both. Not executed here: a keyless
   run starts the egress listener. `README.md:260` omits exit 5.
2. **`trent gateway pair`.** It is named by `GatewayManager.ts:327` (sent to every unpaired user),
   `PairingManager.ts:5` and `:119`, and `docs/gateway.md:61`. It does not exist: `gateway --help`
   lists only status, setup and start, and the command was never in history.
3. **`docs/desktop.md:67`** says `trent web --start` "still reports readiness only". `--start`
   exists at HEAD (`servers.ts:309`), and `web-server.ts:1-14` implements it.
4. **`docs/configuration.md:1234-1238`** ("Not yet implemented") says `voice/`'s "one entry point
   always throws". `core/voice/index.ts:1-12,36` now transcribes with whisper.cpp or faster-whisper,
   and gateway voice notes use it (commit `4a0e171`). docs-truth skips this section by design.
5. **`docs/getting-started.md:457`** says "the repository is private". `gh api
   repos/DreadpiratePickles/trentbalone --jq .private` returns `false`.
6. **`docs/getting-started.md:15,460`: `npm run build:binary`.** The script exists only in
   `apps/cli/package.json:13`; from the root it is "Missing script" (readiness audit §1.8, still true).
7. **`trent setup --portal`, "Quick cloud login setup"** (`diagnostics.ts:157`). It maps to quick
   mode, and `detect.ts:111` prints "Trent has no hosted sign-in".
8. **The global `--dry-run` help** says "perform no writes, network calls or listeners".
   `setup --mode local --dry-run` made HTTP probes to `127.0.0.1:11434` and `:1234`; the output
   carries each runtime's `reachable` and `version`.
9. **`docs/mcp.md:75-77` versus `:189-190`.** The first says "Run `trent mcp test <name>` once it is
   reachable". The second says `add` and `test` cannot connect to an http server from the CLI. For
   remote servers the install-time description scan therefore never runs from the CLI.
10. **`docs/checkpoints.md:114`** describes what "a `trent checkpoints list|rollback` command" reads.
    No such top-level command exists; only the `/checkpoints` and `/rollback` slash commands do.
11. **`trent desktop status`** (the documented form) exits 5 on the release 404; only
    `--no-check` exits 0. A status query should not fail because nothing is published.
12. **`trent run --dry-run` in text mode** prints nothing and exits 0 (readiness audit §1.6, still
    true). With `--json` it echoes flags and resolves no provider, model, mode or budget, so it cannot
    answer "what would this run do".
13. **Index and help omissions.** `docs/README.md` does not list `docs/service.md`. `trent --help`
    calls `fleet` "the 164-specialist agent fleet" (`cli/commands/groups/fleet.ts:25`) while only the
    nine seats run (scorecard §4.5).
14. **Dead code the matrix cites as evidence.** `cli/commands/groups/sessions.ts:240` exports a
    second, unregistered `mcpSpec`. The registered one is `groups/mcp.ts:210`. The harness matrix
    row F2 cites the dead one.

Not verified by me:
- The README's keyed first-run transcript: no key used.
- "Runs after a reboot": the README itself says it was never tried through a reboot.
- The binaries on Windows beyond CI.
- H3, H5 and P3 behaviour: read from their logs, not run.
- Hermes behaviour: read from source, nothing executed.

Minor:
- The launchd label `uk.let-trent.<profile>` ignores `TRENT_HOME`, so a second home with profile
  `default` overwrites the first plist.
- `--version` prints `1.0.0` before any `v1.0.0` exists.

## 6. What I would do first, in order

1. **Pairing** (gap 1, S): `gateway pair|pairings|revoke`, the corrected message text, and a test
   through the real `GatewayManager`. Nothing on the chat side works until this lands.
2. **Land H3 and P3** (gap 2, S): the webhook listener for webhook-only adapters and the correct
   env names from `gateway setup`. They are built.
3. **Keyless to local** (gap 4, S): quick setup and doctor detect a reachable runtime and name
   `trent setup --mode local`.
4. **Service honesty** (gap 6, S): refuse or flag a non-durable daemon; add `service
   start|stop|restart|logs` and `trent logs`.
5. **Docs truth sweep** (§5, S):
   - Fix the 14 items above.
   - Extend `docs-truth.test.ts` from 4 pages to every `docs/*.md`.
   - Add a check that a "Not yet implemented" bullet naming a command, flag or module fails once
     that thing exists (items 3 and 4 would have been caught).
6. **Streaming** (gap 3, M): one additive delta event from solo first, then the REPL, TUI and
   gateway typing or edits. Measure time-to-first-visible-text on the 9B model.
7. **Release** (gap 5): Bobby tags `v1.0.0`; then add the install-e2e job, the Docker image and a
   dependency audit.
8. **ACP permissions and session load** (gap 8, M).
9. **REPL depth and completion** (gap 7, M).
10. **Operator CLI** (gap 9, M): `send`, `profile`, `backup`, `webhook`, `config check`, and `mcp`
    add/test through egress.
11. **A web console over the CLI's own stores** (gap 10, L). This is the one surface that reaches
    the social-manager user who will not live in a terminal.
