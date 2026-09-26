<!-- Every claim is followed by an HTML comment naming the file or command that proves it. Commands ran on 2026-09-25 (macOS arm64, Node v26.8.2, Bun 1.4.2, Docker daemon stopped) at fb90bcb plus the working tree, with `env -i`, throwaway HOME and TRENT_HOME and no provider key unless a comment says otherwise. Log: docs/sessions/2026-09-25-p2-b-readme.md. Supersedes 05_release/output/README-draft-2026-09-25.md. -->

# Trent

[![CI](https://github.com/DreadpiratePickles/trentbalone/actions/workflows/ci.yml/badge.svg?branch=feature/trent-fleet-v2)](https://github.com/DreadpiratePickles/trentbalone/actions/workflows/ci.yml)
<!-- proof: .github/workflows/ci.yml:22-24 runs on push to main and feature/**; run 36198887419 on 68894ea: all-checks-pass success (`gh run view 36198887419 --json jobs`) -->

Trent is an agent team that runs in your terminal, on your machine, with your own model key. A
planner splits an objective into steps and gives each one to one of nine role seats (CEO, engineer,
growth, sales, content, support, analyst, finance and escalation), each with its own toolsets,
approvals, per-run budget in integer cents and eval suite. Anything that sends a message, moves
money or touches a customer asks you first at every autonomy level, and your yes covers that exact
call only.
<!-- proof: `trent fleet list --json` exit 0, 173 agents including the nine seats; `trent fleet show finance` exit 0 (toolsets, denied, gates, "budget 125 cents per run", "eval suite finance"); docs/security.md "Side-effecting tools: the gate" (from line 494); packages/trent-core/src/governance/bound-approvals.ts -->

## The first minute

```
trent fleet install small-business     # four seats, five skills and a persona land in the company brain
trent fleet show finance               # what one seat may do, may not do, must ask about, and may spend
trent run "Write a one-line tagline for a neighbourhood bakery that opens at 6 am"
trent budget status                    # the day's spend against the caps
```

With a Gemini key, that run planned two steps, gave one to the content seat and one to the CEO, and
finished in 15 seconds for 2 cents. Every cents figure is the answering model's list price, and the
cost line the run prints is the ledger's own total. With no key the other three commands work the
same, and the run is refused at every model call, costs $0.00 and exits 1.
<!-- proof: install, show and budget status exit 0 on a keyless profile (output: "installed support, sales, finance, content", "skills booking-followup, invoice-draft, local-business-post, quote-estimate, review-response", "persona brain/system/persona-small-business.md (written, committed)"); the keyed run: 05_release/output/first-run-transcript-2026-09-25.txt ("$0.02 · 15035ms", ledger after `trent usage --json`: 2 cents, 5 rows, all at list price; captured after P2-8, docs/sessions/2026-09-25-p2-8-spend-truth.md); the keyless run: `trent run "Write a one-line tagline for a bakery" --no-color` exit 1, "$0.00" -->

## Install

Needs Node 22 and git. Bun is optional and gives the durable store; Docker is optional and is the
sandbox for the `terminal` and `code` tools. Until v1.0.0 is tagged, run from a clone of this branch:
<!-- proof: apps/web/package.json engines "node": "22.x" (Node 26 runs with EBADENGINE warnings, public-readiness audit 1.7); docs/getting-started.md section 1 (Docker optional, bun for the durable store) -->

```bash
git clone -b feature/trent-fleet-v2 https://github.com/DreadpiratePickles/trentbalone.git trent
cd trent
npm install                                  # also generates the SQLite store's client
alias trent='npm run --silent cli:bun --'    # inside the clone; runs and approvals survive a restart
# alias trent='npm run --silent cli --'      # Node only: the same CLI, state kept in the process
trent doctor
```
<!-- proof: clone with -b because the default branch `main` does not carry this code yet (`gh api repos/DreadpiratePickles/trentbalone/readme` 404); package.json "postinstall" runs `prisma generate` for the SQLite schema and "cli:bun" is `bun --no-env-file apps/cli/src/index.ts` (npm install on a clean worktree: exit 0, 12 s, client generated, docs/sessions/2026-09-25-p2a1-release-path.md); `trent improve status --json` on one profile: under cli:bun {"durable":true} and trent.db exists, under cli {"durable":false,"reason":"the SQLite store needs Bun ..."}; no export line is needed: apps/cli/src/env-defaults.ts sets TRENT_QUEUE_FALLBACK=disabled when it is unset, and the doctor's Standalone Environment Contract check passes without it -->

`trent doctor` runs 23 checks, prints the command that fixes each failure, and exits 3 while one
fails. Then add a key and run setup:
<!-- proof: `trent doctor --no-color` on a keyless profile: "total 22 passed 12 warnings 3 failed 2 skipped 5", exit 3 (API Credentials: no key; Sandbox & Workbench: Docker daemon stopped), each failure followed by a "fix:" line; docs/doctor.md -->

```bash
trent config set GEMINI_API_KEY <your-key>   # or OPENAI_API_KEY, ANTHROPIC_API_KEY; setup lists every one
trent setup --mode quick
trent                                        # the REPL; `trent --tui` for the full-screen UI
```
<!-- proof: setup's key table packages/trent-core/src/setup/detect.ts:12-22 (OpenAI, Anthropic, Google or Gemini, Mistral, OpenRouter, DeepSeek, Groq; ollama and lmstudio need none), printed by a keyless `trent setup`; `config set` routes a secret to <profile>/.env (docs/getting-started.md); --tui in `trent --help` -->

Once v1.0.0 is tagged, the install becomes one line:

```bash
curl -fsSL https://agent.let-trent.uk/install.sh | bash
```
<!-- proof: scripts/install.sh (verifies the signed SHA256SUMS against keys embedded in the script); .github/workflows/release.yml signs and publishes on a v* tag and pages.yml serves the installer once a release exists; today `curl -w '%{http_code}' https://agent.let-trent.uk/install.sh` prints 404, `gh release list` is empty and `git ls-remote --tags` lists no tag -->

## First run

A real run with a Gemini key on a fresh profile (colour off):

```
$ trent run "Write a one-line tagline for a neighbourhood bakery that opens at 6 am"
· Objective: Write a one-line tagline for a neighbourhood bakery that opens at 6 am
· Planning...
· Plan ready
● [Content] Draft Tagline Variants...
    · platform_readiness check · completed
    · platform_readiness check · completed
    Drafted 3 distinct tagline variants for a 6 am neighbourhood bakery with clear rationales, brand alignment notes, and design considerations.

{"draft":"DRAFT v1: 'Warm before the sun. Fresh before the rush.'","rationale":"Focuses on the unique operational advantage of a 6 am opening—getting fresh bread and pastries ready before the morning commute starts. Clean, direct, and rhythmic.","brandAlignment":"Matches the 'Clear, confident, useful' brand voice by stating a plain, undeniable fact that appeals directly to early risers."}
{"draft":"DRAFT v2: 'Your morning starts here at 6:00 AM. The rest is just details.'","rationale":"Positions the bakery as the anchor of the neighbourhood morning routine. Confident, grounded, and habit-forming.","brandAlignment":"Clear and useful; speaks directly to the local customer looking for a dependable morning stop."}
{"draft":"DRAFT v3: 'Hot out of the oven since six.'","rationale":"Short, punchy, and utilitarian. Emphasizes craft and punctuality without fluff.","brandAlignment":"Zero hype, zero corporate jargon. Straightforward craftsmanship."}

Use DRAFT v1 for local signage and window displays where early commuters glance quickly.
Ensure any accompanying visual design uses clean sans-serif typography with high contrast to maintain readability in early morning lighting.
✓ [Content] Draft Tagline Variants
● [CEO] Synthesize and Format Final Output...
    · platform_readiness check · completed
    Synthesized the final selected tagline for Trent Local and completed the source coverage report based on available documents.

Selected Tagline: DRAFT v1: 'Warm before the sun. Fresh before the rush.' ([doc_31u2il0cxtsx])
Source Coverage Report:
- Available sources: Company Operating Brief ([doc_ckmekl85xnxy]) and Content Calendar Draft Tagline Variants ([doc_31u2il0cxtsx]).
- Missing sources / unpopulated fields: Ideal Customer Profile (ICP), Offer, Pricing, Competitors, and Goals are currently unconfigured in the brief.

Use DRAFT v1 for local signage and window displays where early commuters glance quickly, adhering to clean sans-serif typography with high contrast.
✓ [CEO] Synthesize and Format Final Output
· Consolidating...
· Consolidated
✓ Run complete
  $0.02 · 15035ms · run orc_1hyt9kq9xny9
```
<!-- proof: 05_release/output/first-run-transcript-2026-09-25.txt lines 5-38, command `trent run "Write a one-line tagline for a neighbourhood bakery that opens at 6 am" --no-color`, exit 0, gemini-3.5-flash-lite. The only change is that its four `[Worker] Starting job ...` lines are left out: since this change they go to <profile>/logs/run.log instead of the terminal (apps/cli/src/commands/groups/run.ts routeAppOutputToLog; apps/cli/src/commands/__tests__/run-text-log.test.ts; `--verbose` prints them). The JSON draft lines and the one em-dash in them are the model's own output, unedited. -->

With no key, a bare `trent` says `Setup did not complete`, then opens the REPL in a DEGRADED mode
where `/help`, `trent doctor`, `trent config` and `trent fleet list` still work; `/exit` ends it.
<!-- proof: `printf '/exit\r' | trent --no-color` on a fresh keyless profile, exit 0: "Setup did not complete: No provider key found ...", the boot, "◆ DEGRADED MODE ... Without a key these still work: /help, trent doctor, trent config get|set, trent fleet list ...", "Session ended."; no config.yaml written (docs/sessions/2026-09-25-p2a2-first-run.md) -->

## Three crews

`trent fleet packs` lists 14 packs. Three are built for one kind of user each, from the demand
research in `01_discovery/output/market-agents-research-2026-09-19.md`:
<!-- proof: `trent fleet packs` exit 0, "FLEET PACKS (14)"; the research doc sections 0-3 -->

| Pack | Seats and specialists | Skills | What it does today |
|---|---|---|---|
| `small-business` | support, sales, finance, content | quote-estimate, invoice-draft, booking-followup, review-response, local-business-post | With a provider connected: Stripe quotes, invoices and payment links, Google Calendar and Square appointments, Square invoices, outbound Twilio texts, and Bluesky or Buffer posts and comment replies. With none connected, the skills write the same quote, invoice, message or post as a file for you to send |
| `social` | content, growth, analyst, mkt-social-media-strategist, mkt-content-creator | content-calendar, brand-voice-capture, crosspost-adapt, comment-triage | Posts, scheduled posts, replies, the comment inbox and post numbers on Bluesky and any channel Buffer holds (X, LinkedIn, Threads, a Facebook Page; media only from a URL you host); Facebook, Instagram and YouTube replies once Meta or Google is connected and its review passes. No DMs, no YouTube publishing. Without a connection it writes the calendar, posts and triage as files |
| `creator` | content, mkt-short-video-editing-coach, mkt-video-optimization-specialist, design-image-prompt-engineer | hook-lab, caption-and-chapters, repurpose-plan, clip-plan, thumbnail-brief | Probes, transcribes, finds the cuts, clips to 9:16 with burned captions and extracts frames on your machine when ffmpeg is on PATH or the media image is built; a generated thumbnail costs cents and asks first. Without a backend it works from a transcript you supply. Nothing is uploaded or published |
<!-- proof: members, skills and each "state" line from `trent fleet packs` (packages/trent-core/src/fleet/FleetPacks.ts, P2-F); the media backend is reported by the doctor's Media Pipeline line (this machine: ffmpeg, ffprobe, python3 present; whisper-cli, scenedetect missing) -->

Every send, booking, invoice, post and reply waits for your approval of that exact call, and needs
`trent connect <provider>` and the toolset turned on. The business and social toolsets are tested
against local fake servers; neither has been run against a live account.
<!-- proof: docs/business.md:10-13 ("No test reaches a real provider"); docs/social.md:7-8 (fake platform server on the loopback); docs/security.md "Side-effecting tools: the gate"; the pack state lines ("Nothing is sent, booked, invoiced or posted until the owner approves that exact call") -->

## Toolsets

The `toolsets` list in `config.yaml` accepts seventeen names: `file_ops`, `terminal`, `web`,
`browser`, `code`, `vision`, `memory`, `delegation`, `cron`, `skills`, `plugins`, `mcp`, `human`,
`media`, `social`, `business` and `a2a`. A `config.yaml` with no `toolsets` key gets nine of them:
everything except `browser`, `vision`, `memory`, `mcp`, `media`, `social`, `business` and `a2a`.
Quick setup writes all seventeen, except that `media` needs a media backend, `social` and
`business` need a connected provider, and `a2a` needs a peer under `a2a.peers`.

| Toolset | Tools | State |
|---|---|---|
| `file_ops` | `read_file`, `write_file`, `patch`, `search_files` | On by default; confined to the workspace |
| `terminal` | `terminal`, `process_manage` | On by default; Docker sandbox, or the confined local backend |
| `code` | `execute_code` | On by default; python3 or node inside the sandbox |
| `delegation` | `delegate_task` | On by default; delegated child steps |
| `web` | `web_search`, `web_extract` | On by default; through the egress proxy |
| `skills` | `skills_list`, `skill_view`, `skill_manage` | On by default |
| `cron` | `cronjob_manage` | On by default; the schedule `trent cron` ticks |
| `plugins` | `plugins_list` and each plugin manifest's commands | On by default; a plugin cannot take a built-in tool's name |
| `human` | `ask_human` | On by default; the seat asks you and waits |
| `memory` | `memory`, `fleet_search`, `fleet_skill_view`, `brain_read` | Always on, registered by the fleet-memory hook |
| `browser` | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, and more | Opt-in; needs a Chromium |
| `vision` | `vision_analyze` | Opt-in; sends the image to the configured model |
| `mcp` | `mcp_<server>_<tool>`, `mcp_status` | Opt-in; servers from `trent mcp add`, scanned at install |
| `media` | `media_probe`, `media_transcribe`, `media_scenes`, `media_clip`, `media_thumbnail`, `media_image` | Opt-in; local ffmpeg and whisper, or the media image; `media_image` costs cents and asks each time |
| `social` | `social_platforms_list`, `social_post`, `social_reply`, `social_inbox_list`, `social_insights_read`, `social_schedule` | Opt-in; every post, reply and scheduled post asks |
| `business` | `customer_search`, `stripe_invoice_create`, `stripe_invoice_send`, `stripe_quote_create`, `stripe_payment_link_create`, `calendar_list`, `calendar_appointment_create`, `calendar_appointment_cancel`, `square_bookings_list`, `square_booking_create`, `square_booking_cancel`, `square_invoice_create`, `square_invoice_send`, `sms_send` | Opt-in; every write asks |

`todo`, `clarify` and `session_search` are registered on every build, and the `tool_search`,
`tool_describe` and `tool_call` bridge whenever there is a tool worth deferring.
<!-- proof: docs/tools.md (the media, business and social tables at lines 66-86; the bridge at 34-38); docs/media.md:5-18; docs/brain.md:10 (`brain_read`); docs/tools.md:57-59 (no bridge when nothing is worth deferring); docs/getting-started.md section 5 (todo, clarify, session_search on every build); the reserved names are derived from the registries (packages/trent-core/src/tools/tool-names.ts, tools/tool-names.test.ts: a plugin claiming social_post, brain_read or fleet_skill_view is refused, P2-5a) -->

## How it compares with Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is the open-source agent Trent's
feature set is measured against. Where the two differ:
<!-- proof: 01_discovery/output/hermes-feature-inventory-2026-09.md:3 ("Parity target for Trent"); 02_plan/output/hermes-parity-scorecard-2026-09-25.md -->

| | Trent (this branch) | Hermes Agent |
|---|---|---|
| Install | From a clone. The installer and the release workflow that signs its downloads exist; no tag has been pushed, so there is nothing to download yet | One-line installer, native Windows, Docker, Nix, Termux; tagged releases |
| Language | TypeScript, Node 22 or Bun | Python 3.11 |
| Agent shape | Nine fixed role seats; a planner gives each step to one. 164 catalog specialists install profiles and skills the seats read; only the seats run | One agent that delegates to subagents (nested, parallel batches) |
| Spend | Per-run and daily caps in integer cents on one ledger for every surface, each call at its model's list price; `trent run --max-cost-cents` stops a run with exit 6 | Usage and cost analytics, documented as a lower bound and off by default; turn and wall-clock budgets |
| Side effects | Send, money-moving and customer-facing calls ask at every autonomy level; the approval is bound to the exact arguments | Approval modes smart, manual, off; YOLO skips prompts except a hardline blocklist |
| Credential isolation | Egress proxy swaps an opaque token for the real key | The same design (iron-proxy) |
| Checkpoints and rollback | Yes | Yes |
| Self-improvement | Eval-gated drafts wait in quarantine; nothing goes live without `trent improve promote` | A background review writes memory and skills every few turns |
| Audit trail | Hash-chained export with a detached Ed25519 signature | Not in our inventory |
| Messaging | 12 adapters | 24+ platforms |
| Runs after a reboot | `trent service install`: a launchd agent or systemd user unit that starts at login and restarts on exit; not yet tried through a real reboot | `hermes gateway install`: a systemd user or system unit, a launchd agent, or a Windows Scheduled Task |
| Voice | Voice notes on Telegram, WhatsApp, Signal, Discord and Slack are transcribed on your machine after pairing; replies are text | Voice mode, local and hosted speech-to-text, ten text-to-speech backends, a wake word |
| Plugins | Local plugin manifests; MCP servers | Curated, SHA-pinned plugin catalog (223 entries); 65 curated MCP presets |
| Skills | One skill store with a pre-install scan and a curator; the three market packs ship 14 skills | 59 bundled and 149 optional skills |
| Memory | A profile brain in files, versioned with git; imports md, txt, csv, pdf, docx, xlsx | Built-in memory plus external memory providers |
| Desktop | Tauri app in the tree, not packaged | Electron app with macOS and Windows installers |
| A2A | Server (0.3.0 and v1.0) and client: `a2a_list`, `a2a_discover`, `a2a_send`, `a2a_history`, every send behind the approval gate; Hermes discovers and calls it | Server and client |
<!-- proof, Trent column: Install: release.yml, pages.yml, scripts/install.sh; no tag (`git ls-remote --tags` empty). Language: package.json, docs/getting-started.md section 1. Agent shape: `trent fleet list --json` (173); pack state lines ("the specialists install profiles and skills the seats can read and are not scheduled on their own"). Spend: `trent budget status`; `trent run --help` ("6 over --max-cost-cents"); list price: docs/sessions/2026-09-25-p2-8-spend-truth.md. Side effects: docs/security.md from line 494. Credential isolation: docs/security.md "Egress credential brokering" (line 13). Checkpoints: docs/checkpoints.md. Self-improvement: docs/improve.md. Audit trail: docs/security.md "Signed audit export" (line 129), `trent audit export|verify`. Messaging: packages/trent-core/src/gateway/platforms/ (discord, email, homeassistant, line, matrix, mattermost, ntfy, signal, slack, teams, telegram, whatsapp; registry.test.ts "registers exactly the twelve spec platforms"). Reboot: docs/service.md (RunAtLoad and KeepAlive; Restart=always, WantedBy=default.target), packages/trent-core/src/service/units.ts; the P2-D run wrote and linted the unit and ran the daemon in the foreground, and never loaded it into launchd (docs/sessions/2026-09-25-p2d-service.md). Voice: docs/gateway.md "Voice notes"; real transcript "Book me for Tuesday." in docs/sessions/2026-09-25-p2-3-voice-notes.md. Plugins: docs/mcp.md. Skills: docs/skills.md; `trent fleet packs` (5 + 4 + 5 skills). Memory: docs/brain.md; the doctor's Brain Import Extractors line. Desktop: docs/desktop.md; release.yml:298-307 (desktop job not wired). A2A: packages/trent-core/src/a2a/ (no client); docs/a2a.md.
     proof, Hermes column: the inventory, lines 21-25 (install), 21 (Python 3.11), 308 and 334-337 (subagents), 317 and 89 (cost, budgets), 383 and 385 (approvals, YOLO), 204 (iron-proxy), 78 (checkpoints), 495 (background review), 96 (24+ platforms), 101 (service lifecycle), 91-94 (voice mode, speech-to-text, ten text-to-speech backends, wake word), 698 and 250 (plugin catalog 223, MCP presets 65, skills 59 and 149), 232 and 456 (memory providers), 406 (desktop), 143 (A2A in and out). "Not in our inventory" means the 913-line inventory has no such row, not that Hermes lacks it. -->

If you already run Hermes, Trent is reachable from it over A2A. If you need many messaging platforms,
a plugin catalog, spoken replies or a desktop app today, Hermes has them and Trent does not.
<!-- proof: docs/a2a.md (discovery and calls proven live with Hermes v0.21.3, docs/sessions/2026-09-20-a2a-v1-wire.md); the rows above -->

Where Trent is ahead:

1. **Nine role seats in one run.** Each seat has its own toolsets, the toolsets it may not touch,
   the approvals it needs, a per-run budget in integer cents, a model tier and an eval suite;
   `trent fleet show <seat>` prints them.
2. **Money, messages and bookings always ask, and a yes covers exactly one call.** At every autonomy
   level, including `never`, a send, charge or booking asks first, and the approval is bound to that
   exact recipient, amount, text and time; a repeat is answered from the idempotency store instead of
   sent twice.
3. **Spend caps that stop the run.** Model and tool spend land on one ledger in integer cents; the
   daily cap refuses a turn, the per-run cap stops a run, and `trent run --max-cost-cents` exits 6.
4. **A shared company brain with a truth rule.** Identity, decisions and notes are git-versioned
   Markdown under `<profile>/brain/`; indexes are disposable; imported PDFs, Word and Excel files are
   chunked and cited by chunk id; recall@8 over a golden set is a gate.
5. **Self-improvement that cannot grade itself.** Drafts are judged by an evidence-checked judge on a
   different model, decided on a held-out split with pass^k, rolled back automatically on a
   regression, and promoted only by a human.
6. **Real executors for a small business and a social account.** Stripe invoices, quotes and payment
   links; Google Calendar; Square bookings and invoices; Twilio texts; posts, replies and scheduled
   posts on Facebook, Instagram, Bluesky and any Buffer channel, each behind the per-call approval.
7. **A local clip studio.** Probe, transcribe, find the cuts, clip to 9:16 with burned captions and
   pull thumbnails, on the host's ffmpeg and whisper or in a media container.
8. **Agents that travel.** Export a Trent agent to Claude Code, Codex or Hermes, and import theirs as
   a candidate version.
9. **An audit trail you can verify offline, and rules over tool sequences.** A signed, hash-chained
   export, and rules such as "read a secret, then send" denied before the second call.
<!-- proof: 02_plan/output/hermes-parity-scorecard-2026-09-25.md section 3, items 1-9 in its words, each with its evidence there (fleet/seat-capabilities.ts; governance/bound-approvals.ts and idempotent-dispatch.ts; governance/spend-ledger.ts; fleet-memory/brain.ts and ingest/; improve/judge-model.ts, suite-split.ts, pass-k.ts, post-promote.ts; tools/business/ and tools/social/; tools/media/; fleet/export-{claude,codex,hermes}.ts and import-*; audit/signing.ts and governance/policy-rules.ts). Item 6 runs against fake servers only; see the next section. -->

## What is not done yet

- **No release.** No tag has been pushed, so the installer URL returns 404 and `trent update` and
  `trent desktop install` have nothing to download. The release and Pages workflows exist and have
  never run. The default branch `main` does not carry this code yet.
  <!-- proof: `curl -w '%{http_code}' https://agent.let-trent.uk/install.sh` 404; `gh release list` empty; `gh run list --limit 200` lists only CI runs; `git ls-remote --tags` 0 lines; `gh api repos/DreadpiratePickles/trentbalone --jq .default_branch` main; `gh api .../readme` 404 -->
- **Durable state needs Bun.** Under Node (`npm run cli`) runs and approvals live in the process, and
  the REPL says so; `npm run cli:bun` keeps them in `<profile>/trent.db`.
  <!-- proof: `trent improve status --json` under each runtime (see Install); the REPL line "This session is not durable: the SQLite store needs Bun" -->
- **Live accounts.** The business and social toolsets have not been run against real providers. Meta
  App Review and Business Verification, YouTube and Google Business Profile access are pending, and
  the direct Facebook, Instagram and YouTube paths also need the app's Postgres store.
  <!-- proof: docs/business.md:13; docs/social.md:51 and :103; docs/sessions/2026-09-19-upgrade-round.md "Open after the follow-up wave" -->
- **Retrieval quality.** On this repository's own 28 docs (625 chunks, 35 answerable questions),
  hybrid recall@8 is 0.629 (lexical alone 0.343; paraphrased questions 0.417), under the 0.9 the
  design set. A reranker is decided, not landed.
  <!-- proof: docs/sessions/2026-09-25-p2-6-recall.md (lexical baseline, live measurement, the gate fix 0.400 -> 0.629, "Trigger fired"); packages/trent-core/src/improve/docs-corpus.test.ts -->
- **Prompt caching on the default model.** The stable part of a seat's prompt now leads its system
  prompt. On gemini-3.6-flash a second objective was served 8,164 of 10,808 input tokens from cache
  in one of two runs; the default gemini-3.5-flash-lite returned 0 cached tokens in 7 tries, so on
  the default model the saving is zero.
  <!-- proof: docs/sessions/2026-09-25-p2-7-stable-first.md "LIVE proof" table; docs/sessions/2026-09-25-p1c-model-cost.md; parity-push log, P1-C findings -->
- **Spoken replies.** Voice notes come in as text; nothing answers in speech, and the gateway never
  uses hosted transcription.
  <!-- proof: docs/gateway.md "Voice notes" ("The hosted path is never used here"); docs/sessions/2026-09-25-p2-3-voice-notes.md -->
- **The desktop app is not packaged or signed.**
  <!-- proof: .github/workflows/release.yml:298-307 ("NOT WIRED"); docs/desktop.md -->
- **Windows.** The `windows-x64` binary is built and run on a Windows CI runner; the PowerShell
  installer has never been executed.
  <!-- proof: CI run 36198887419 job "binaries / RUN trent-windows-x64.exe on windows-latest" success; 05_release/output/release-checklist-v1.md step 22 ("never executed") -->
- **A2A** has no push notifications, no `tasks/resubscribe`, no non-text parts, and the client does not stream, poll or cancel a task yet.
  <!-- proof: packages/trent-core/src/a2a/ (server files only); docs/a2a.md:131-150 -->
- **Known defects in the wrapped application** are listed, not hidden:
  [docs/security.md](docs/security.md) ("Reported, not fixed") and `AGENTS.md`.

## Commands

`trent --help` lists 36 commands, 155 with their subcommands. The ones most people start with:
<!-- proof: `npx tsx apps/cli/src/index.ts --help` exit 0; the counts are checked against COMMAND_SPECS by docs-truth.test.ts "states the command counts the registry actually has" -->

```
trent                                  # the REPL (quick setup on first launch); /exit or Ctrl+D ends it
trent run "<objective>"                # one objective, no terminal; exit 0 done, 1 failed, 3 config,
                                       # 6 over --max-cost-cents, 7 waiting on approval, 130 interrupted
trent run "<objective>" --model <id>   # the whole run (planner, critic, consolidator, every seat) on one model
trent run - --format stream-json       # objective on stdin, one JSON object per line
trent --tui                            # full-screen terminal UI on the same session engine
trent doctor                           # 23 checks; exit 3 on a configuration failure
trent fleet packs                      # also: install <pack>, show <seat>, list
trent service install                  # gateway, cron and heartbeat as one launchd or systemd service
trent approvals list                   # everything waiting on you; approve <id> / reject <id>
trent budget status                    # today's spend against the caps
trent usage                            # spend from the ledger by surface, seat, model, provider or tool
trent brain import <path>              # md, txt, csv, pdf, docx, xlsx into the company brain
trent security audit                   # read-only report over this profile; exit 1 on a finding
trent a2a serve                        # Agent-to-Agent server; `trent acp` speaks ACP over stdio
trent connect <provider>               # stripe, google, square, twilio, buffer, meta, bluesky
```
<!-- proof: descriptions and exit codes from `trent --help`, `trent run --help` (--model, --format, --max-cost-cents, --verbose), `trent service --help` (daemon, install, uninstall, status) and `trent fleet --help`; `/exit` is registered in apps/cli/src/repl/commands.ts (P2-5a); text-mode `trent run` writes the wrapped app's own lines to <profile>/logs/run.log unless `--verbose` -->

## Documentation

Every page is indexed in [docs/README.md](docs/README.md). The ones to start with:

| Page | Covers |
|---|---|
| [getting-started.md](docs/getting-started.md) | From a clone to a first conversation, including a first run with no key |
| [local-models.md](docs/local-models.md) | A model on this machine: the hardware tiers, `setup --mode local`, what to expect, the limits |
| [configuration.md](docs/configuration.md) | `config.yaml`, the profile `.env` for secrets, profiles, every setting |
| [doctor.md](docs/doctor.md) | The health checks, their exit codes, `--json`, `--fix` |
| [troubleshooting.md](docs/troubleshooting.md) | Failure modes that have happened, each with the command that identifies it |
| [fleet.md](docs/fleet.md) | The seats, the specialist catalog, packs, versions, export and import |
| [goals.md](docs/goals.md), [jobs.md](docs/jobs.md) | Standing goals with shell quality gates; the run cap and failed jobs |
| [cron.md](docs/cron.md), [heartbeat.md](docs/heartbeat.md), [service.md](docs/service.md) | Scheduled jobs, the periodic check, and both as one supervised service |
| [improve.md](docs/improve.md) | The self-improvement loop and the gates that stop it grading itself |
| [skills.md](docs/skills.md), [brain.md](docs/brain.md), [checkpoints.md](docs/checkpoints.md) | The skill store, the company brain, and rolling a turn back |
| [tools.md](docs/tools.md), [terminal.md](docs/terminal.md), [browser.md](docs/browser.md) | Tool disclosure, the sandbox backends, the browser and vision toolsets |
| [media.md](docs/media.md), [social.md](docs/social.md), [business.md](docs/business.md) | The media, social and business toolsets |
| [connect.md](docs/connect.md), [mcp.md](docs/mcp.md) | Provider credentials and the token store; MCP servers in and out |
| [gateway.md](docs/gateway.md), [a2a.md](docs/a2a.md), [desktop.md](docs/desktop.md) | Messaging adapters and voice notes; A2A and ACP; the Tauri app |
| [security.md](docs/security.md) | Egress brokering, the sandbox, approvals, the side-effect gate, what is reported but not fixed |
| [the rulebook](docs/development_methodology_and_coding_rulebook.md) | How this repository is planned, built and verified |
<!-- proof: every linked file exists (`ls docs/*.md`: 28 pages including README.md); descriptions follow docs/README.md, whose index predates docs/service.md -->

## Tests

CI runs on every push to `main` and `feature/**`. Its last green run recorded on 2026-09-25 (run
36198887419, commit 68894ea): the core and CLI suite 3953 passed, 23 skipped (404 files); the
wrapped web app's suite 2829 passed, 125 skipped (528 files); the Docker-dependent suites 231 passed
(33 files); typecheck, lint, the repo scan, the installer render from a clean checkout, and four
binaries built with `bun build --compile`, each then run on its own OS.
<!-- proof: .github/workflows/ci.yml:22-24; docs/sessions/2026-09-25-parity-push.md (the last CI line: the serial Bun suites commit green); `gh run view 36198887419 --json jobs` (every job success); job logs via `gh run view --job <id> --log`: 108281128569 "Tests 3953 passed | 23 skipped (3976)", "Test Files 404 passed (404)"; 108281128483 "Tests 2829 passed | 125 skipped (2955)", "Test Files 515 passed | 13 skipped (528)"; 108281128788 "Tests 231 passed (231)", "Test Files 33 passed (33)"; "binaries / RUN trent-<target> on <os>" x4 success -->

Locally: `npx vitest run` for the core and CLI, `npm run test:web` for the web app. The rules this
repository is built under (failing test first, no claim without a command and its exit code,
`apps/web/` is read-only) are in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
<!-- proof: package.json scripts "test", "test:web"; AGENTS.md "Global invariants"; CONTRIBUTING.md exists (P2-A2) -->

## License

MIT. See [LICENSE](LICENSE).
<!-- proof: LICENSE (MIT); package.json "license": "MIT" -->
