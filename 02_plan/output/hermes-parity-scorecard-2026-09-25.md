# Hermes parity scorecard, 2026-09-25

For the person deciding what to build next. Trent's stated aim (Bobby): "a better Hermes with all
the features of Hermes and all the features of Trent (nine agents with roles, persistent memory,
self-improving agents, a shared brain)", for three users: a mom-and-pop assistant, a social-media
manager, a creator clipping agent.

- **Trent side:** HEAD `4328956` on `feature/trent-fleet-v2`. The evidence pass ran on `981218c`
  (= `1d1418c` plus two browser-test commits that change no row); `4328956` (inbound email must carry
  an authenticated From:) landed during the pass and was re-read, which moves row 39 to parity. Every
  file path below was read with `git show HEAD:<path>` or `git grep ... HEAD`; uncommitted work from
  today's wave P1 (locks, cached tokens, reasoning effort, secrets fallback, cron pin) is **not**
  counted and is marked "in flight".
- **Hermes side:** `01_discovery/output/hermes-feature-inventory-2026-09.md` (baseline §1.1-§1.11,
  §3, plus the four dated "New since" sections through 2026-09-23; newest release v0.21.4 =
  v2026.9.21). Cited as "inv §x" or "inv 09-2x".
- **Decisions:** `02_plan/output/hermes-parity-roadmap-2026-09-18.md` ("roadmap"),
  `implementation-plan-hermes-parity.md` ("plan"), `upgrade-round-design.md` ("URD"), the gate
  decisions in `docs/sessions/2026-09-19-upgrade-round.md`, and the proposals in
  `docs/sessions/2026-09-2[0-3]-daily-parity.md` ("daily 09-2x").
- **Commands run** (all with `TRENT_QUEUE_FALLBACK=disabled`; the fleet commands with `TRENT_HOME`
  pointed at an empty scratch directory, which stayed empty): `npx tsx apps/cli/src/index.ts --help`
  exit 0 (34 commands); `<group> --help` for all 34 groups, each exit 0; `fleet list --json` exit 0
  (173 agents: 9 seats + 164 specialists, every specialist `toolsCount: 0`); `fleet packs` exit 0;
  `fleet show finance` exit 0. No test suite was run for this document.

Status legend: **parity** (a user can do what Hermes users do, maybe differently), **ahead** (Trent
has something Hermes lacks in that area), **partial**, **missing**, **deliberately-not** (a recorded
decision says not now). Size to close the gap: S (under a day, ~150 lines), M (days), L (a week or
more). "Who notices": mom-and-pop, social, creator, developer, everyone, or nobody yet.

## Counts

44 areas: **parity 7, ahead 9, partial 21, missing 4, deliberately-not 3.**

## 1. Scorecard

| # | Area | Hermes (one line) | Trent (one line + evidence) | Status | Who notices | Size |
|---|---|---|---|---|---|---|
| 1 | Install, release, update, backup | Live curl and PowerShell installers, Docker image, Nix, tagged releases (v0.21.4), `hermes update` with receipts, backup/restore, shell completion (inv §1.1, inv 09-22) | Installers written (`scripts/install.sh`, `scripts/install.ps1`), four native binaries in CI (`.github/workflows/binary.yml`), sign-and-publish workflows (`.github/workflows/release.yml`, `pages.yml`), `trent update --check/--rollback/--channel` (`packages/trent-core/src/updater/selfUpdate.ts`); but `git tag` lists 0 tags, so nothing is installable; no backup/restore or completion command in `trent --help` | partial | everyone | S (Bobby-gated) |
| 2 | Setup, config, doctor | Sectioned setup (quick/full/blank), `config get/set/check/migrate`, `doctor --fix`, `dump`, `prompt-size`, OSV supply-chain audit (inv §1.1) | `setup --mode quick/full/blank-slate`, `config get/set/unset/list`, `doctor --fix` over 22 checks (`packages/trent-core/src/doctor/checks/`, 22 files), `trent security audit` over the profile (`governance/security-audit.ts`); no support bundle, no dependency (OSV) audit | parity | developer | - |
| 3 | Profiles | `profile create/clone/rename/export/import/install`, distributions, one OAuth grant shared across profiles (inv §1.1, inv 09-22) | `--profile <name>` selects a directory (`config/ConfigManager.ts:44`), `config list` lists them (`docs/configuration.md:892`); no create/clone/export/import; secrets strictly per profile (`connect/store.ts`) | partial | social (one profile per client), mom-and-pop (new laptop) | M |
| 4 | Cross-harness portability | `import-agent claude-code/codex`, `claw migrate`; exports only its own profile distributions (inv §1.1) | `fleet export --target claude/hermes/codex` and `fleet import --from claude/codex/hermes` (`fleet/export-{claude,codex,hermes}.ts`, `fleet/import-{claude,codex,hermes}.ts`); live Hermes import proof (`docs/sessions/2026-09-20-w5-hermes-codex-export.md`) | ahead | developer | - |
| 5 | One-shot and scripted runs | `chat -q`, `-z`, `--format stream-json`, distinct exit codes, `--usage-file` (inv §1.2) | `trent run [objective or -] --format stream-json --max-cost-cents --resume`, exits 0/1/3/6/7/130 (`trent run --help`; `apps/cli/src/commands/groups/run.ts`) | parity | developer | - |
| 6 | REPL, TUI, slash commands, personalities | ~100 slash commands, keybindings, status bar, `!` shell escape, quick commands, `@file` references, 9 skins, 14 personalities, TUI session switcher (inv §1.2) | 19 REPL slash commands (`apps/cli/src/repl/commands.ts`, `goal-commands.ts`), turn queue and `/stop` (`repl/engine.ts`), Ink TUI with five modals and a palette (`apps/cli/src/tui/`), 6 personalities (`personalities/built-in.ts`) plus three pack personas; no `!`, `@file`, quick commands or skins (git grep) | partial | developer | M |
| 7 | Sessions, checkpoints, worktrees | SQLite+FTS5 store, resume by title or directory, archive/pin/rename/repair, export jsonl/md/qmd/html, `/handoff`, opt-in checkpoints with `/rollback`, git worktree isolation (inv §1.2) | `sessions list/resume/export/search/prune`, FTS5 (`store/session-fts.ts`), search windows `--after/--before/--exclude`, export is JSON only; agent-write ledger on by default (`checkpoints/config-schema.ts:20`) with `/checkpoints` and `/rollback` (`repl/commands.ts:381,411`); no worktrees (git grep `worktree`: no functional hit) | partial | developer | M (worktrees deferred "until a coding user asks", roadmap §3 Phase E) |
| 8 | Context management | Dual compression, micro-compaction, three-tier prompt, `tool_search`, `/context`, pressure warnings, spill to disk (inv §1.2) | Compaction with a memory flush and one recorded event (`sessions/compaction.ts`), STABLE/CONTEXT/VOLATILE tiers (`fleet-memory/tiers.ts`, `orchestrator-hook.ts`), `/context` (`repl/context-report.ts`), 80 percent `context_pressure` notice, `tool_search/tool_describe/tool_call` (`tools/tool_search/`), spill over 24K (`tools/spillover.ts`); no micro-compaction | parity | developer | - |
| 9 | Prompt caching | Always-on Anthropic/OpenRouter prefix cache, `cache_ttl: 5m/1h/auto`, cached tokens accounted (inv §1.2, inv 09-22) | None: `cache_control`, `cached_tokens` and `cachedInputTokens` have 0 hits in `packages/` and `apps/cli/`; the stable tier is appended to `dynamicPrompt` after the pipeline's per-step text (`fleet-memory/orchestrator-hook.ts:34-36`) | missing | everyone (the bill) | S-M |
| 10 | Goals, heartbeat, verify-on-stop | `/goal` with shell gates, subgoals, parking; `/heartbeat`; `/loop`; `verify_on_stop` opt-in (inv §1.6) | `goal create --gate --contract`, `goal continue` (`packages/trent-core/src/goals/`), `verify_on_stop` default true (`goals/config-schema.ts:23`), `HEARTBEAT.md` loop with quiet hours (`heartbeat/HeartbeatLoop.ts`); no `/loop`, no subgoals | parity | mom-and-pop (heartbeat), developer | - |
| 11 | Voice | Push-to-talk voice mode, 7+ STT and 10 TTS backends, wake word, inbound voice memos transcribed (inv §1.2) | File transcription only, via `media_transcribe` (`tools/media/transcribe.ts`); `voice/index.ts` is exported but nothing calls `transcribeVoice` (git grep); no TTS (0 hits `text_to_speech`, `tts`) | missing | mom-and-pop, creator | M |
| 12 | Gateway core and always-on service | One gateway process installed as a systemd/launchd/Windows service, watchdog, allowlists and DM pairing, admin tiers, approvals in chat, busy modes, delivery ledger, circuit breaker, home channel, `hermes send`, PII redaction; the gateway also runs cron (inv §1.3) | `gateway setup/start/status` (`apps/cli/src/commands/groups/servers.ts`), default-deny pairing with admin tiers (`gateway/security/PairingManager.ts`), reaction approvals (`gateway/ApprovalBridge.ts`), double-text queue (`gateway/ConversationQueue.ts`), `gateway/queue/CircuitBreaker.ts`, `gateway.owner` alerts, `privacy.redact_prompts`; no service install (launchd/systemd appear only as `--once` hints, `cron.ts:307`, `heartbeat.ts:182`), no send command, no delivery ledger, no process lock at HEAD; gateway, cron and heartbeat are three foreground processes | partial | mom-and-pop, social | M |
| 13 | Messaging platforms | About 30 adapters: WhatsApp personal (QR) and Cloud, SMS/Twilio, iMessage (BlueBubbles, Photon), Google Chat, Matrix, Mattermost, LINE, seven China-market, IRC and more (inv §1.3) | 8 in `gateway/registry.ts`: Telegram, Discord, Slack, WhatsApp Cloud API, Signal, email, Teams, Home Assistant; SMS is outbound only (`tools/business/sms.ts`) | partial (8 of ~30) | mom-and-pop | L (roadmap §3 Phase E defers "sixteen platforms"; URD gate decision 4: outbound SMS only) |
| 14 | Inbound webhooks and event triggers | HMAC-validated routes that start runs, deliver, or fire cron jobs; `hermes webhook subscribe`; outbound signed webhooks (inv §1.3, §1.9) | `gateway/WebhookServer.ts` routes `/webhooks/<platform>` to messaging adapters only; no generic route, no event-to-run, no outbound webhook (hooks are four local kinds, `hooks/types.ts:15`) | missing | mom-and-pop, social | M (URD §3: public webhook surface "a later decision") |
| 15 | Multi-agent surfaces: Bot Mode, rooms, peer, Kanban, multiplex | Bots with rooms and @mentions, `hermes peer` across machines, Kanban with dispatcher, one host gateway for all profiles (inv §1.3, §1.8, inv 09-21..23) | None; the nine seats inside one orchestrated run are the design's answer (row 16) | deliberately-not | nobody yet | L (roadmap §3 Phase B defers the board, B4; Phase E defers "bots, rooms and trent peer") |
| 16 | Role seats and orchestrator | Separate profiles or Bots; Kanban routes tasks to profiles; no per-agent money cap or eval suite (inv §1.3, §1.8) | Nine seats in one orchestrated plan, each with toolsets, denied toolsets, gates, a per-run cents budget, a model tier and an eval suite (`trent fleet show finance`: budget 125 cents per run, denied file_ops/terminal/code/social, eval suite finance; `fleet/seat-capabilities.ts`); seat shrink gone (0 hits `SHRINK` in `apps/web/lib/orchestrator-runtime.ts`) | ahead | mom-and-pop, social, creator | - |
| 17 | File, terminal, code tools, sandbox backends | Document extraction and LSP diagnostics in the file tools; terminal with PTY, background and completion notices; `execute_code` calling tools over RPC; seven backends (docker, ssh, modal, daytona, singularity, vercel) with limits (inv §1.4, §1.5) | `read_file/write_file/patch/search_files` with fuzzy patch (`tools/file_ops/`), `terminal` + `process_manage` background processes (`tools/terminal/processes.ts`), `execute_code` python3/node in the sandbox (`tools/code_execution/`); backends `docker` and `local` only (`config/sections/terminal.ts:9`); no LSP, PTY or document extraction in `read_file` | partial | developer | M |
| 18 | Web, browser, computer use | Several search backends plus `x_search`; browser over Browserbase, Browser Use, local CDP, Camofox; `computer_use`; Bot Screen take-over and hand-back (inv §1.4, inv 09-23) | `web_search` (Tavily) and `web_extract` (Jina) through the egress proxy with SSRF floors (`tools/web/index.ts`, `tools/web/url-safety.ts`); 12 browser tools on local Chromium via the proxy (`tools/tool-names.ts`, `tools/browser/chromium.ts`); no computer use (0 hits) | partial | social, developer | M (browser), L (computer use) |
| 19 | Vision, image and video generation | `vision_analyze`, `video_analyze`, `image_generate` (FAL 11 models, OpenAI, xAI, custom), `video_generate` (xAI, Veo, Kling, LTX) (inv §1.4, inv 09-22) | `vision_analyze` (`tools/vision/`), `media_image` through the app's image router, asking first (`tools/media/image-tool.ts`), `media_scenes`; no video generation (0 hits `video_generate`) | partial | creator, social | M |
| 20 | Creator clip pipeline | No clip, scene-cut or caption-burn tool in the registry (inv §1.4 lists none) | `media_probe/transcribe/scenes/clip/thumbnail` on a host or Docker backend, 9:16 clips with burned captions (`tools/media/`, `docs/media.md`, `trent sandbox build --media`); the creator pack's skills call them (`packages/trent-core/skills/clip-plan/SKILL.md`, 21 tool references) | ahead | creator | - |
| 21 | Small-business executors | No payment, booking, invoicing or SMS-send tool in the registry (inv §1.4); only through MCP servers or plugins | 15 `business` tools: Stripe invoices, quotes and payment links, Google Calendar, Square bookings and invoices, Twilio SMS, each behind a per-call bound approval (`tools/business/`, `docs/business.md`) | ahead | mom-and-pop | - |
| 22 | Social executors | Read-only `x_search`; no post, reply or schedule tool (inv §1.4) | 6 `social` tools (post, reply, inbox, insights, schedule, platforms) over Meta Graph, Bluesky and Buffer with an approved post queue (`tools/social/`, `docs/social.md`, `trent cron queue`) | ahead | social | - |
| 23 | Delegation and subagents | `delegate_task` with parallel batches (10 concurrent), live list/steer/stop, `output_schema`, depth, per-child worktrees, image forwarding, `/review` (inv §1.8, inv 09-20) | `delegate_task` over the orchestrator's delegation path, at most 6 tasks (`tools/delegate/index.ts:21`), goal and context only, "no steer/stop control plane and no schema validator" (`:30`) | partial | developer | M (roadmap §3 Phase B defers steer/stop and child worktrees, B3) |
| 24 | Cron | Natural-language and interval schedules, skill-backed jobs, per-job model/provider/effort pins, continuity, no-agent and monitor modes, chaining, webhook triggers, incidents, quota hold (inv §1.8, inv 09-20, 09-21) | `cron add/list/pause/resume/remove/run/runs/start/incidents/queue` (`apps/cli/src/commands/groups/cron.ts`), five-field cron or `@aliases` only (`cron add --help`), delivery target, incidents and quota hold (`cron/incidents.ts`, `cron/CronRunner.ts:225-318`); no per-job model, skills, chaining or no-agent mode (`cron/config-schema.ts`) | partial | mom-and-pop, social | S |
| 25 | Memory and shared brain | Bounded `MEMORY.md`/`USER.md` per profile, add/replace/remove, hard limit, optional write approval (inv §1.6) | Bounded blocks (`tools/memory/blocks.ts`) inside a git-versioned `<profile>/brain/` with a truth rule per layer (`fleet-memory/brain.ts` header, `docs/brain.md` §1), cross-seat recall, hybrid lexical plus embedding recall (`fleet-memory/hybrid.ts`, `embedder.ts`), document import with chunk-id citations (`trent brain import`, `fleet-memory/ingest/`), a recall@8 gate (`trent improve retrieval`), untrusted writes held (`tools/memory/holds.ts`) | ahead | mom-and-pop, social, creator | - |
| 26 | External memory providers | Seven bundled plus catalog providers (Honcho, Mem0, Supermemory...) behind a plugin contract (inv §1.6, inv 09-23) | None | deliberately-not | nobody yet | M (roadmap §3 Phase C: "Deferred: external memory providers (C6)") |
| 27 | Skills store and hub | Skills Hub over eight source types and GitHub taps, trust levels, quarantine scan, 59 bundled and 149 optional, bundles, blueprints, skills as slash commands (inv §1.6) | `skills browse/search/install/view/remove/list` over 10 built-in (`skills/SkillsHub.ts`), about 113 app-bundled (`apps/web/.agents/skills`) and 14 core skills (`packages/trent-core/skills/`), pre-install scan (`skills/SecurityScan.ts`), trust tiers (`skills/skill-store.ts`); no remote hub, taps, publish or update | partial | developer, social | M |
| 28 | Self-improvement and curator | Background review writes memory and skills; curator ages and consolidates with an append-only ledger; nothing learned is graded on held-out data (inv §1.6) | `improve sweep` with GEPA, an evidence-checked judge on a different model (`improve/judge-model.ts`), holdout split (`improve/suite-split.ts`), pass^k (`improve/pass-k.ts`), post-promotion auto-rollback (`improve/post-promote.ts`), content-hash veto (`improve/veto.ts`), frozen surface (`improve/frozen-surface.ts`), human `promote`; tool-description proposals (`improve tools`); curator with ledger and undo (`trent curator`, `curator/`) | ahead | developer (every user indirectly) | - |
| 29 | Learning from conversations | Review fork every 10 prompts and 10 tool iterations saves memory and skills; `/refine`; `/learn <dir, url, pdf>` authors a skill (inv §1.6) | Seats write memory through the `memory` tool; the sweep's skill foundry drafts skills from traces into quarantine (`improve/sweep.ts:268`); the unattended sweep is opt-in (`heartbeat.sweep.enabled` default false, `config/sections/heartbeat.ts:32`); no session review, `/refine` or `/learn` (0 hits) | partial | mom-and-pop, social | M (roadmap §3 D2 option (i), "after A1 delivers the stable prefix") |
| 30 | Models, providers, routing, local | ~40 API-key providers, 10 subscription/OAuth logins (Nous Portal, ChatGPT/Codex, Copilot, Claude Max...), Bedrock/Azure/Vertex, custom endpoints, fallback chain, credential pools, 11 auxiliary slots, MoA, reasoning effort, managed llama.cpp (inv §1.7) | 5 providers (`model-gateway/types.ts:17`) plus 4 OpenAI-compatible aliases ollama/lmstudio/deepseek/groq (`model-gateway/providers.ts`), fallback chain (`model-gateway/index.ts`), bounded retry with Retry-After (`model-gateway/retry.ts`), auto-recovery (`orchestrator/auto-recovery.ts`), a separate judge model; API keys only, no OAuth login, no `reasoning_effort` (0 hits), no pools or MoA | partial | mom-and-pop, social, creator (onboarding), developer | M (roadmap §3 Phase E defers llama.cpp, MoA, credential pools) |
| 31 | Cost and budget | `/usage`, `/insights`, `hermes usage`; analytics a stated lower bound, off by default; wall-clock run budget (inv §1.7) | One ledger for model and external-tool spend (`governance/spend-ledger.ts`, `spend-report.ts`), `daily_cap` and `per_run_cap` refuse or stop a run (`docs/configuration.md:680`), per-seat cents budgets, `run --max-cost-cents` (exit 6), `trent usage --by surface/seat/model/provider/tool`, `trent budget status`; cached tokens not priced (row 9) | ahead | mom-and-pop, social, creator | - |
| 32 | Observability, logs, trajectories | `hermes logs` with filters, Langfuse, OTLP gateway monitoring, observer hooks, delegation transcripts, trajectory export, batch runner (inv §1.7) | OTLP trace export with gen_ai conventions when `telemetry.otlp_endpoint` is set (`traces/OTelExporter.ts`, `config/telemetry-schema.ts`), trace store (`traces/trace-store.ts`), `improve status`, `jobs failed`; no `trent logs`, Langfuse, trajectory export or batch runner | partial | developer | S |
| 33 | OpenAI-compatible API server | `/v1/chat/completions`, `/v1/responses`, runs/jobs/sessions REST (inv §1.7) | None in the CLI (0 hits for `/v1/chat/completions` outside the model gateway); `trent web` serves the wrapped app's UI | deliberately-not | developer | M (roadmap §3 Phase E defers "API server") |
| 34 | MCP client and connector catalog | stdio/HTTP client, 65+ curated manifests installed disabled, OAuth 2.1 PKCE and device flow, include/exclude, trust tiers, sampling guards (inv §1.9) | `mcp list/add/remove/test` over stdio and HTTP (`tools/mcp/client.ts`), install-time description scan and result scrub (`tools/mcp/scan.ts`), `--auto-approve`, a 9-entry vetted gallery (`apps/web/lib/mcp-connector-catalog.ts`); headers and env only, no OAuth (0 hits in `tools/mcp/`), no tool filters | partial | social, mom-and-pop, developer | M |
| 35 | Protocol servers: MCP serve, ACP, A2A | `hermes mcp serve` (messaging surface), ACP with session load/resume/fork, A2A in and out (`a2a_call`, `a2a_discover`) (inv §1.3, §1.9) | `trent mcp serve` exposes toolsets over stdio or Streamable HTTP with a bearer and `needs_approval` (`mcp-server/`); `trent acp` stdio with initialize/new/prompt/cancel and `loadSession: false` (`acp/stdio.ts:167`); `trent a2a serve` speaks A2A v1.0 and 0.3.0 (`a2a/v1.ts`) and Hermes's own client calls it live (`docs/sessions/2026-09-20-hermes-a2a-discovery-proof.md`); no A2A client (0 hits `a2a_call`) | partial | developer | M |
| 36 | Plugins and hooks | Allowlisted discovery, install from catalog or git pinned to a SHA, 285-entry curated catalog, capability consent, install scan, 12 extension points, middleware; ~29 hook events, shell hooks with consent, outbound signed webhooks (inv §1.9, inv 09-21..23) | Tool-only `plugin.json` manifests, 0600, every call asks (`tools/plugins/`); four hook kinds (pre/post tool call, session start/stop) with consent by spec hash (`hooks/types.ts:15`, `hooks/consent.ts`, `trent hooks`) | partial | developer | L |
| 37 | Command approvals and safety floor | `approvals.mode smart/manual/off` (an LLM classifier), headless deny defaults, YOLO, hardline blocklist, deny globs, once/session/always allowlist, `approvals suggest`, Tirith, website blocklist (inv §1.10) | Autonomy `ask_always/ask_dangerous/never` above an unliftable floor: hardline list, `approvals.deny` globs, approval floors (`governance/autonomy.ts`, `hardline.ts`, `deny-globs.ts`, `tools/approval-floors.ts`); durable approvals in REPL, TUI and gateway (`trent approvals`); no LLM mode, no persistent always-allow, no website blocklist (0 hits) | partial | developer | S |
| 38 | Side-effect gate, policy rules, signed audit | Approvals cover commands; no binding of a send or charge to its preview, no rules over tool sequences, no signed audit export (inv §1.10 lists none) | A class floor asks before every send, charge and booking at every autonomy level (`governance/gate-config-schema.ts`), the approval is bound to the exact call and its idempotency key (`governance/bound-approvals.ts`, `idempotent-dispatch.ts`), policy rules over tool sequences (`governance/policy-rules.ts`), untrusted provenance (`governance/provenance.ts`), an Ed25519-signed hash-chained audit export (`audit/signing.ts`, `trent audit export/verify`) | ahead | mom-and-pop, social | - |
| 39 | Inbound sender authentication (email) | Acts on email only when `Authentication-Results` authenticates the From: domain (DMARC or aligned SPF/DKIM); whole-address allowlist (inv 09-23) | Since `4328956`: IMAP fetches `AUTHENTICATION-RESULTS` and `RECEIVED-SPF` (`gateway/platforms/email/imap.ts:28`), `email/auth-results.ts` accepts only a DMARC pass or an aligned DKIM/SPF pass, anything else is dropped before pairing; opt-out `gateway.email.require_authenticated_from` (default true, `config/sections/gateway.ts:27`). At `981218c` the From: header was trusted (daily 09-23 proposal 1) | parity | mom-and-pop | - |
| 40 | Egress and SSRF | iron-proxy credential broker, default-deny host allowlist, connect-time CIDR deny, Bitwarden-sourced keys; SSRF checks on every URL tool (inv §1.5, §1.10) | TLS-intercepting broker with opaque tokens, deny by default at CONNECT and on the decrypted request (`egress/EgressProxy.ts:6-9`), SSRF floors re-checked on every redirect (`tools/web/url-safety.ts`) | parity | developer | - |
| 41 | Secret sources and vaults | Bitwarden, 1Password and command-helper sources; credential pools; password-blind browser vault; managed scope (inv §1.5) | Profile `.env` plus a 0600 secrets file (`config/sections/secrets.ts`, `connect/store.ts`); no vault source (0 hits bitwarden, 1password), no pools | missing | developer | M (roadmap §3 Phase E defers the browser credential vault and pools; vault sources are not mentioned) |
| 42 | Context files and workspace trust | AGENTS.md/CLAUDE.md/.cursorrules priority chain, subdirectory discovery, injection scanning, `@` references (inv §1.6) | AGENTS.md, CLAUDE.md and `.trent/*.md` load only after the workspace is trusted and each file passes the injection scan (`workspace-context/`, `trent workspace status/trust/untrust`) | parity | developer | - |
| 43 | Desktop and web UI | Electron app (panes, terminal, review, HUD, tray, Bot Screen, plugins hub), a web dashboard over every subsystem, `hermes serve` (inv §1.11) | Tauri v2 shell around the wrapped Next.js UI with tray and notifications (`apps/desktop/src-tauri/src/`), `trent desktop install/launch/status/uninstall` (nothing to download until a release), `trent web --start` | partial | mom-and-pop, social, creator | L (roadmap §3 Phase E defers HUD, in-app browser, MCP centre) |
| 44 | Documentation | ~461 docs pages and per-plugin pages (inv §5) | 25 user pages under `docs/` plus README; README's documentation table lists 21 and omits `business.md`, `connect.md`, `media.md`, `social.md` | partial | everyone | S |

## 2. Top 15 gaps, ranked by outcome

Ranked by "a Trent user can do something they cannot today", weighted toward the three market
users. Items 2, 8, 9 and 10 have work in flight today (wave P1, uncommitted); the scorecard counts
HEAD only. The email sender check, which headed this list at `981218c`, landed as `4328956` and is
off it.

**1. Install with one command.** Hermes: `curl ... install.sh | bash` is live, releases are tagged
(v0.21.4), a Docker image ships (inv §1.1, inv 09-22). Trent needs: a `v<semver>` tag on `main` so
`release.yml` signs and publishes and `pages.yml` serves `agent.let-trent.uk`; the signing keys in
repository secrets; the branch merged. Files: `.github/workflows/release.yml`, `pages.yml`,
`apps/cli/package.json` (version), `scripts/install.sh`, README install section,
`05_release/output/release-checklist-v1.md`. Failing test: a post-release smoke job that runs the
published `install.sh` on clean macOS and Linux runners and asserts `trent --version` equals the tag
fails today with a 404. Size S, Bobby-gated. Decision: roadmap §3 Phase F ("needs Bobby"), plan
decision 9.

**2. An assistant that is still answering after the laptop reboots.** Hermes: `hermes gateway
install/start/stop/status` as a systemd, launchd or Windows service; one gateway process also runs
cron (inv §1.3). Trent needs: `trent gateway install/uninstall` rendering a LaunchAgent, a systemd
user unit or a Scheduled Task that runs gateway, cron and heartbeat in one supervised process, plus
the per-profile lock so two starts never answer twice. Files:
`apps/cli/src/commands/groups/servers.ts`, a new `packages/trent-core/src/gateway/service.ts`,
`cron/CronRunner.ts`, `heartbeat/HeartbeatLoop.ts`, a doctor line, `docs/gateway.md`. Failing test:
`trent gateway install --dry-run --json` on darwin returns a plist with `RunAtLoad` and `KeepAlive`
whose arguments end in `gateway start`, on linux a unit with `Restart=on-failure`, and a second
`gateway start` on the same profile exits 3 naming the first pid. Size M. Decision: daily 09-21
proposal 1 and 09-23 proposal 2 cover the lock (in flight as P1-B); the service install is not
recorded anywhere.

**3. Customers can text the shop.** Hermes: an SMS (Twilio) adapter with mandatory
`X-Twilio-Signature` validation (inv §1.3). Trent needs: an `sms` platform adapter on the existing
`WebhookServer`, pairing and approvals as on every other platform, and a public ingress (tunnel or
relay) for Twilio to reach. Files: new `gateway/platforms/sms.ts`, `gateway/registry.ts`,
`gateway/WebhookServer.ts`, `config/sections/gateway.ts`, `docs/gateway.md`. Failing test
(`sms.wire.test.ts`): a webhook with a valid signature from a paired number reaches the handler and
the reply goes out through the Messages API; a bad signature gets 403 and reaches nothing. Size M.
Decision: deliberately-not this round (URD §3; gate decision 4; deferred decision 1 of 2026-09-20);
reopening it needs Bobby.

**4. Voice notes in, spoken replies out, on the channels Trent already has.** Hermes: inbound voice
memos auto-transcribed; ten TTS backends; voice mode (inv §1.2). Trent needs: audio attachments on
Telegram, WhatsApp and Signal routed through `transcribeVoice` into the objective, and a
`media_speak` tool whose file the adapter sends as a voice message. Files:
`gateway/platforms/{telegram,whatsapp,signal}.ts`, `voice/index.ts`, new `tools/media/speech.ts`,
`config/sections/media.ts`, `docs/media.md`. Failing test (`telegram.wire.test.ts`): a voice note from
a paired user becomes the run objective through the local whisper engine; with no engine the user
gets one line naming what to install and no run starts. Size M. Decision: none recorded.

**5. A booking form, a Stripe payment or a new order can start the agent.** Hermes: HMAC webhook
routes that start a run, deliver, or fire a cron job; `hermes webhook subscribe` (inv §1.3). Trent
needs: `gateway.webhooks.routes` (secret env, prompt template, deliver target, optional cron job),
`/hooks/<name>` on `WebhookServer`, `trent webhook add/list/remove/test`. Files:
`gateway/WebhookServer.ts`, `config/sections/gateway.ts`, new
`apps/cli/src/commands/groups/webhook.ts`, `cron/CronRunner.ts`, `docs/gateway.md`. Failing test: a
POST to `/hooks/new-booking` with a valid HMAC starts exactly one run whose objective renders the
payload and delivers to `gateway.owner`; a wrong signature gets 401 and a replayed delivery id
starts nothing. Size M. Decision: URD §3 calls the public webhook surface "a later decision".

**6. Start without an API key.** Hermes: ten subscription or OAuth logins and a managed Tool
Gateway (inv §1.7). Trent needs: `trent connect` providers whose token the model gateway uses for
the providers whose terms allow third-party use (OpenRouter's PKCE key exchange is the clean first
one), and quick setup offering it. Files: `connect/providers.ts`, `connect/oauth.ts`,
`connect/resolver.ts`, `model-gateway/index.ts`, `orchestrator/model-env.ts`, `setup/QuickSetup.ts`,
`docs/connect.md`. Failing test: with no `*_API_KEY` set and only an OpenRouter key from the connect
store, `trent run --dry-run --json` resolves provider `openrouter` from `connect`, and
`trent config get OPENROUTER_API_KEY` still reports unset. Size M. Decision: none recorded.

**7. Teach it once.** Hermes: a review fork every 10 prompts saves memory and skills; `/learn`
turns a directory, URL, PDF or "how I just did X" into a skill (inv §1.6). Trent needs:
`trent skills learn <path or url>` reusing the brain import extractors to draft a SKILL.md with
`created_by: agent` into curator quarantine, and a session-end review that proposes memory entries
through the existing held-write path. Files: new `improve/session-review.ts`,
`apps/cli/src/repl/engine.ts`, `apps/cli/src/commands/groups/skills.ts`, `fleet-memory/ingest/`,
`skills/foundry.ts`, `curator/`. Failing test: `trent skills learn ./price-list.pdf` produces one
quarantined draft listed by `trent curator status` and seen by no seat until `trent curator
release`. Size M. Decision: roadmap §3 D2 option (i), after A1's stable prefix.

**8. One profile per client, and a move to a new laptop.** Hermes: `profile create --clone`,
`export/import`, `hermes backup`/`restore`, one OAuth grant shared across profiles (inv §1.1, inv
09-22). Trent needs: `trent profile create/clone/export/import` and `trent backup/restore`, secrets
excluded by construction, and a read-only fallback to the default profile's connect tokens. Files:
new `apps/cli/src/commands/groups/profile.ts`, `config/ConfigManager.ts`, `connect/resolver.ts`,
`fleet/targz.ts`, `docs/configuration.md`. Failing test: `trent profile create acme --clone
default` copies `config.yaml`, skills and `brain/system/` but no `.env` or token; export then import
round-trips byte-identical files and the archive holds no secrets file. Size M. Decision: daily
09-22 proposal 3 covers the fallback (in flight as P1-D).

**9. Schedules a shop owner can read, on the model they chose.** Hermes: `every 2h`, natural
language, skill-backed jobs, per-job model and effort pins (inv §1.8, inv 09-21). Trent needs:
`every <n><unit>` and `every weekday at HH:MM`, `--model`, `--skill`, passed into the run input.
Files: `tools/cron/cron-expression.ts`, `tools/cron/index.ts`, `cron/CronRunner.ts`,
`apps/cli/src/commands/groups/cron.ts`, `docs/cron.md`. Failing test: `cron add --schedule "every
weekday at 09:00" --model <m> --skill weekly-digest` stores a job whose next run is the next weekday
09:00 local, whose run input names that model and whose seat prompt loads that skill. Size S.
Decision: daily 09-21 proposal 4 (pin, in flight as P1-D).

**10. Pay less for the same run, and see the true number.** Hermes: always-on prefix caching with
`cache_ttl: auto`, cached tokens accounted (inv §1.2, inv 09-22). Trent needs: read cached-token
counts, price them at the cached rate, record them on the ledger, and put the stable tier where a
provider cache can hit it; today it is appended after per-step text inside `dynamicPrompt`, and the
prompt order lives in read-only `apps/web/lib/model-gateway.ts`, so this needs a scoped invariant-1
exception or a wrapper-side reorder. Files: `model-gateway/attempts.ts`, `model-gateway/index.ts`,
`model-gateway/pricing.ts`, `governance/spend-ledger.ts`, `fleet-memory/orchestrator-hook.ts`.
Failing test: a usage frame carrying `prompt_tokens_details.cached_tokens` prices them at the cached
rate and the ledger row records `cachedInputTokens`; live, the second of two identical seat calls
reports cached tokens above zero. Size S-M. Decision: roadmap §3 A1 and plan wave 2 A1.2
(`cache_control` on the stable tier, never done); daily 09-22 proposal 1; in flight as P1-C.

**11. Connect Gmail, Notion or Shopify with a browser login.** Hermes: MCP OAuth 2.1 with PKCE and
device flow, 65+ curated manifests, include/exclude filters (inv §1.9). Trent needs: `trent mcp
login <name>` on the existing loopback OAuth flow, refresh, a bearer header from the secrets file,
tool include/exclude, and a larger vetted gallery. Files: `tools/mcp/client.ts`,
`tools/mcp/config.ts`, `config/sections/mcp-servers.ts`, `connect/oauth.ts`,
`apps/cli/src/commands/groups/mcp.ts`, `docs/mcp.md`. Failing test: `trent mcp login <name>` against
the fake OAuth server stores a refreshable token, `trent mcp test <name>` sends it as a bearer, and
an expired token is refreshed once without ever printing it. Size M. Decision: none recorded.

**12. Reach customers where they already are.** Hermes: personal WhatsApp by QR, iMessage through
BlueBubbles or Photon, Google Chat, Matrix, Mattermost, LINE and more (inv §1.3). Trent needs: one
adapter file and one registry entry per platform, each proved by the transport contract. Files: new
`gateway/platforms/<name>.ts`, `gateway/registry.ts`, `docs/gateway.md`. Failing test:
`registry.test.ts` runs the full transport contract against the new adapter's fake server. Size L
(M per platform). Decision: roadmap §3 Phase E defers "sixteen platforms".

**13. Steer or stop a subagent, and get typed results.** Hermes: `delegate_task` with list, steer
and stop, `output_schema` with one correction turn, 10 concurrent children (inv §1.8). Trent needs a
control plane on the delegate port and a schema validator. Files: `tools/delegate/index.ts`,
`tools/delegate/types.ts`, `orchestrator/delegate-port.ts`, `orchestrator/delegate-child.ts`.
Failing test: a `delegate_task` with an `output_schema` returns `schema_valid: false` and exactly one
correction turn when a child's JSON misses a required field, and `action: stop` returns the partial
result. Size M. Decision: roadmap §3 Phase B defers steer/stop and child worktrees (B3).

**14. Install someone else's plugin safely.** Hermes: install from a catalog or a git URL pinned to
a 40-hex SHA, an install-time scan, capability consent, a 285-entry curated catalog (inv §1.9, inv
09-23). Trent needs: `trent plugins install <git-url>@<sha>` with checkout at that commit, the
existing scanner, a provenance file, and refusal to move a pinned plugin. Files:
`tools/plugins/manifest.ts`, `tools/plugins/index.ts`, new
`apps/cli/src/commands/groups/plugins.ts`, `skills/SecurityScan.ts`, `docs/tools.md`. Failing test:
`trent plugins install <url>@<sha>` checks out exactly that commit, refuses a manifest the scan
flags, records the SHA, and `trent plugins update` refuses to move it. Size L. Decision: none
recorded.

**15. Talk to Trent from any chat app that speaks the OpenAI API.** Hermes: `/v1/chat/completions`
with streaming, `/v1/responses`, and runs/jobs/sessions REST, so Open WebUI, phone clients and
scripts reach the agent (inv §1.7). Trent needs: a loopback-by-default server (bearer required
off-loopback, the rule `trent mcp serve` already follows) mapping one chat completion to one
orchestrated run on the existing session, streaming the run's text, and returning an approval park
as an explicit message, never a silent allow. Files: new `apps/cli/src/commands/groups/api-serve.ts`,
new `packages/trent-core/src/api-server/`, reusing `agent-runner/index.ts` and `mcp-server/transport.ts`
patterns; `docs/a2a.md` or a new page. Failing test: a streamed `POST /v1/chat/completions` on
loopback returns SSE chunks whose text is the run's own output and a final `[DONE]`, a non-loopback
bind without `TRENT_API_TOKEN` refuses to start, and a run parked on an approval ends with a message
naming the approval id. Size M. Decision: deliberately-not (roadmap §3 Phase E defers "API server");
reopening it needs Bobby.

### Not Hermes gaps, but they block the three users today

- **The small-business and social packs still say drafts-only, and their skills call no
  executor.** `trent fleet packs` prints "Nothing is sent, booked, invoiced or posted until the
  business toolset ... lands" and "until the social toolset lands" (`fleet/FleetPacks.ts:158,168`,
  `fleet/pack-personas.ts:25`, `docs/fleet.md:241-242`), although both toolsets landed in `fd51f62`.
  None of the nine skills in those packs names a `stripe_`, `square_`, `calendar_`, `sms_send` or
  `social_` tool (0 references each), while the creator pack's `clip-plan` names media tools 21
  times. Size S. Failing test: `trent fleet packs --json` gives small-business a state that names
  the business tools and their per-call approval, and `invoice-draft/SKILL.md` names
  `stripe_invoice_create` and the approval step.
- **Nothing Trent makes can be posted with media.** Buffer refuses a media URL
  (`buffer_media_unsupported`, `tools/social/buffer.ts:8-10`), the Bluesky path attaches no images,
  Instagram needs a publicly hosted URL and YouTube has no publish path (`docs/social.md`, the
  matrix). A creator's clips and a social manager's images stop at the owner's hand. Size M.
- **Direct Meta and YouTube need Postgres.** On a standalone profile the social toolset offers only
  Buffer and Bluesky (`docs/social.md`, "Direct Meta and YouTube paths need the app store").
- **Platform reviews and Google Business Profile access** wait on Bobby's applications
  (`docs/sessions/2026-09-19-upgrade-round.md`, "Open after the follow-up wave").

## 3. Where Trent is ahead (wording a README can use)

1. **Nine role seats in one run.** Each seat has its own toolsets, the toolsets it may not touch,
   the approvals it needs, a per-run budget in integer cents, a model tier and an eval suite;
   `trent fleet show <seat>` prints them. Evidence: `trent fleet show finance` (exit 0);
   `fleet/seat-capabilities.ts`.
2. **Money, messages and bookings always ask, and a yes covers exactly one call.** At every
   autonomy level, including `never`, a send, charge or booking asks first, and the approval is
   bound to that exact recipient, amount, text and time; a repeat is answered from the idempotency
   store instead of sent twice. Evidence: `governance/gate-config-schema.ts`,
   `governance/bound-approvals.ts`, `governance/idempotent-dispatch.ts`, `docs/business.md`.
3. **Spend caps that stop the run.** Model and tool spend land on one ledger in integer cents;
   the daily cap refuses a turn, the per-run cap stops a run, and `trent run --max-cost-cents` exits
   6. Evidence: `governance/spend-ledger.ts`, `docs/configuration.md:680`, `trent run --help`.
4. **A shared company brain with a truth rule.** Identity, decisions and notes are git-versioned
   Markdown under `<profile>/brain/`; indexes are disposable; imported PDFs, Word and Excel files are
   chunked and cited by chunk id; recall@8 over a golden set is a gate. Evidence:
   `fleet-memory/brain.ts`, `docs/brain.md` §1, `fleet-memory/ingest/`, `trent improve retrieval`.
5. **Self-improvement that cannot grade itself.** Drafts are judged by an evidence-checked judge on a
   different model, decided on a held-out split with pass^k, rolled back automatically on a
   regression, and promoted only by a human. Evidence: `improve/judge-model.ts`,
   `improve/suite-split.ts`, `improve/pass-k.ts`, `improve/post-promote.ts`, `trent improve promote`.
6. **Real executors for a small business and a social account.** Stripe invoices, quotes and
   payment links; Google Calendar; Square bookings and invoices; Twilio texts; posts, replies and
   scheduled posts on Facebook, Instagram, Bluesky and any Buffer channel, each behind the per-call
   approval. Evidence: `tools/business/`, `tools/social/`, `docs/business.md`, `docs/social.md`.
7. **A local clip studio.** Probe, transcribe, find the cuts, clip to 9:16 with burned captions and
   pull thumbnails, on the host's ffmpeg and whisper or in a media container. Evidence:
   `tools/media/`, `docs/media.md`, `trent sandbox build --media`.
8. **Agents that travel.** Export a Trent agent to Claude Code, Codex or Hermes, and import theirs
   as a candidate version. Evidence: `fleet/export-{claude,codex,hermes}.ts`,
   `fleet/import-{claude,codex,hermes}.ts`, `docs/sessions/2026-09-20-w5-hermes-codex-export.md`.
9. **An audit trail you can verify offline, and rules over tool sequences.** A signed, hash-chained
   export, and rules such as "read a secret, then send" denied before the second call. Evidence:
   `audit/signing.ts`, `trent audit verify`, `governance/policy-rules.ts`.

## 4. Claims to retract or qualify

1. **"`toolsets` accepts thirteen names"** (`README.md:171`; `docs/getting-started.md:88,96`). The
   schema accepts sixteen: `media`, `social` and `business` were added
   (`config/sections/tools.ts`, `ToolsetSchema`); quick setup writes those three only when a backend
   or provider is found (`setup/QuickSetup.ts:68`). The README Tools table (`README.md:153-169`) and
   Documentation table (`README.md:314-334`) omit the three toolsets and `connect.md`; `docs/tools.md`
   has them.
2. **"no workflow publishes the installer or signs a release"** (`README.md:27`) and **"no workflow
   signs it or publishes a release yet"** (`README.md:256`). `release.yml` signs and publishes on a
   `v*` tag and `pages.yml` serves the installer once a release exists (both since `8630e98`,
   2026-09-19). Truthful: the workflows exist; no tag has been pushed (`git tag` lists none).
3. **The test counts "Measured on 2026-09-15"** (`README.md:294-300`, 1765 passed) are stale; the last
   recorded clean-HEAD run is 3608 passed, 1 skipped, 370 files
   (`docs/sessions/2026-09-23-daily-parity.md` §4). Not re-run for this document.
4. **The small-business and social pack states** (`fleet/FleetPacks.ts:158,168`,
   `fleet/pack-personas.ts:25`, `docs/fleet.md:241-242`, printed by `trent fleet packs`) say the
   toolsets have not landed; they have (`tools/business/`, `tools/social/`, commit `fd51f62`).
   Truthful: "sends, bookings, invoices and posts run through the business/social toolsets once a
   provider is connected, each asking per call; this pack's skills do not call them yet".
5. **"trent fleet install <id>  # install a specialist with its tools, skills and model"**
   (`README.md:60`; also "164 further specialists can be installed on top", `README.md:7`).
   `trent fleet list --json` shows `toolsCount: 0` for all 164 specialists, and `docs/fleet.md:220-222`
   says specialists "are never scheduled on their own". Truthful: "installs a specialist's profile and
   skills for the seats to read; only the nine seats run".
6. **`trent setup --portal` "Quick cloud login setup"** (`apps/cli/src/commands/groups/diagnostics.ts:151`).
   The flag maps to quick mode (`:156`) and `setup/QuickSetup.ts:21` says there is no portal to sign
   into. Retract the description or remove the flag.
7. **"names cannot shadow built-ins"** (`README.md:160`) and "Every tool name Trent's own toolsets
   answer to" (`tools/tool-names.ts:1-3`). The reserved list omits the six `social_*` tools,
   `brain_read` and `fleet_skill_view`, so the plugin manifest check (`tools/plugins/manifest.ts:81`)
   does not refuse those eight names. Fix the list rather than the sentence.
8. **AGENTS.md known defect 9** lists as open four wrapper defects the tree has fixed: the two skill
   stores (`tools/skills/store.ts:1-8`, "the one skill store"), the memory-draft lock bypass and the
   dead `TRENT_FLEET_RECALL_BUDGET_CHARS` reader (`fleet-memory/README.md:198-203`), and the
   first-seat prelude memoisation (`fleet-memory/orchestrator-hook.ts` header, "Until 2026-09-18").
   Still true: under Node the durable layers are `EphemeralStore` (`apps/cli/src/runtime/headless.ts:216-218`).
9. **"so the cacheable prefix does not move between turns"** (`docs/configuration.md:676`) and
   "never moves the cacheable bytes" (`docs/brain.md:68-69`). Nothing asks a provider to cache (0
   hits `cache_control`), cached tokens are never read or priced, and the injection sits after the
   pipeline's per-step text in `dynamicPrompt` (`fleet-memory/orchestrator-hook.ts:34-36`).
   Qualify as "ordered so a provider cache could hit; not measured".
10. **CONTEXT.md shared resources** point "current design" at `02_plan/output/design-doc.md` and "task
    list" at `implementation-plan.md`; the live plans are `implementation-plan-hermes-parity.md` and
    `upgrade-round-design.md`.

Resolved during the pass, no longer to retract: "Device pairing is default-deny" (`docs/gateway.md:31`)
was not true for email at `981218c`, because the sender id was the unauthenticated From: header;
`4328956` makes it true.

## 5. What this document did not check

No test suite, live model call or network probe was run; `trent doctor` was not run (its credential
check calls providers). Hermes rows are taken from the inventory as written; nothing on the Hermes
side was re-fetched. Counts such as "~30 Hermes adapters" and "~113 app skills" are counted from the
inventory's rows and `git ls-tree` directory listings, not from running either product.
