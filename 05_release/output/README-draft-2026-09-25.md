<!--
  DRAFT for README.md, written 2026-09-25 by the public-readiness audit
  (05_release/output/public-readiness-audit-2026-09-25.md). Every claim is followed by an HTML
  comment naming the file or the command that proves it. Commands were run on macOS arm64,
  Node v26.8.2, Bun 1.4.2, Docker daemon stopped, in a fresh clone of feature/trent-fleet-v2 at
  981218c, with a throwaway TRENT_HOME and no provider key.
  Edit when these land: audit fix 1 (default branch: drop "-b feature/trent-fleet-v2"), fix 4
  (keyless setup exit code: delete that "Not done yet" line), fix 5 (drop the export line),
  fix 6 (durable store: replace the Bun paragraph), fix 7 (release: the install block becomes the
  one-line installer), P1-A (email sender verification: delete that "Not done yet" line).
-->

# Trent

[![CI](https://github.com/DreadpiratePickles/trentbalone/actions/workflows/ci.yml/badge.svg?branch=feature/trent-fleet-v2)](https://github.com/DreadpiratePickles/trentbalone/actions/workflows/ci.yml)
<!-- proof: ci.yml:22-30 runs on push to main and feature/**; run 35905708927 on 1d1418c: all-checks-pass success (gh run view 35905708927 --json jobs) -->

Trent is an agent team that runs in your terminal, on your machine, with your own model key. A
planner splits an objective into steps and gives each step to one of nine role seats: CEO, engineer,
growth, sales, content, support, analyst, finance and escalation.
<!-- proof: `trent fleet list --json` returns 173 agents, the nine seats among them; `trent run` transcript below shows steps assigned to [CEO] and [Engineer] -->

Each seat has a written record of what it may do, what it may not do, which actions always wait for
your approval, and how many cents it may spend per run. Anything that sends a message, moves money or
touches a customer asks you first, at every autonomy level, and your yes covers that exact call only.
<!-- proof: `trent fleet show finance` (transcript below); docs/security.md "Side-effecting tools: the gate" (lines 494-540); packages/trent-core/src/governance/bound-approvals.ts -->

## The first minute

From a clone, with no API key, each of these takes under two seconds and the run under four:

- install a crew for a kind of business and see its seats, skills and persona land in the company brain;
- read what one seat may do, may not do, must ask about, and may spend;
- send an objective through the planner and watch every step (with no key, every model call is
  refused, the run costs $0.00 and exits 1);
- read the day's spend against the caps.

With a key, the same `trent run` returns model output.
<!-- proof: wall times on the audit machine, fresh profile, `npm run --silent cli -- <args>`: --version 1.68 s, fleet install small-business 1.43 s, fleet show finance 1.22 s, run 3.78 s (exit 1, "$0.00 · 1994ms" of run time), budget status 1.39 s; clone 3 s, npm install 13 s with an empty npm cache -->

## Install

Needs Node 22 and git. Docker is optional (the sandbox for the `terminal` and `code` tools); Bun is
optional (the durable store, below).

```bash
git clone -b feature/trent-fleet-v2 https://github.com/DreadpiratePickles/trentbalone.git trent
cd trent
npm install
export TRENT_QUEUE_FALLBACK=disabled
alias trent='npm run --silent cli --'
trent doctor
```
<!-- proof: git clone exit 0 (3 s); npm install exit 0 (13 s); `trent doctor` prints "total 22" and exits 3 on a keyless profile, 0 once every check passes (docs/doctor.md). Without the export the doctor adds a failure: `env -i ... npm run --silent cli -- doctor` -> "failed 3", exit 3. apps/web/package.json pins node 22.x; Node 26 installs with EBADENGINE warnings and runs. -->

`trent doctor` runs 22 checks and exits 3 when one fails; each failure prints the command that fixes
it. Then add a key and run setup:

```bash
trent config set OPENAI_API_KEY <your-key>     # or ANTHROPIC_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY,
trent setup --mode quick                       #    OPENROUTER_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY
trent                                          # the REPL; `trent --tui` for the full-screen UI
```
<!-- proof: setup's own keyless guidance lists exactly these seven variables (packages/trent-core/src/setup/detect.ts:105-121, printed by `trent setup --mode quick`); `config set` routes a secret to <profile>/.env and `config get` answers [set] (docs/getting-started.md:117-129); --tui in `trent --help` -->

With a Gemini key, also `export GOOGLE_MODEL_DEFAULT=gemini-3.6-flash`: the wrapped application's
default Google model is retired.
<!-- proof: docs/getting-started.md:141-150 -->

**Durable store.** Run under Node as above, runs and approvals live in the process and do not survive
a restart; the REPL says so. For the SQLite store at `$TRENT_HOME/trent.db`, generate its client once
and run under Bun:

```bash
npx prisma generate --schema packages/trent-core/prisma/schema.sqlite.prisma
alias trent='bun --no-env-file apps/cli/src/index.ts'
```
<!-- proof: under Node the REPL prints "This session is not durable: the SQLite store needs Bun." (apps/cli/src/repl/index.ts:289; apps/cli/src/runtime/headless.ts:211-219). In a fresh clone under Bun the store fails with "Cannot find module './generated/client'" until the prisma generate above (exit 0, 1 s); after it, the Bun REPL prints no warning and trent.db exists. --no-env-file: docs/troubleshooting.md:186-193 -->

## First run

Real output, on a fresh profile with no key (colour removed; `$TRENT_HOME` stands for the profile path):

```
$ trent --version
1.0.0

$ trent fleet install small-business
  installed support, sales, finance, content
  skills  booking-followup, invoice-draft, local-business-post, quote-estimate, review-response
  persona brain/system/persona-small-business.md (written, committed)

$ trent fleet show finance
SEAT FINANCE — Finance/Ops Controller
  toolsets     browser, business, cron, delegation, human, mcp, media, memory, plugins, skills, vision, web
  denied       file_ops, terminal, code, social
  unavailable  usage:read
  gates        charge, refund, subscription.change, budget.increase, payout, steel.login, steel.submit, steel.purchase, steel.download, steel.cookies, vault.reindex, vault.export, vault.delete, gitnexus.analyze, gitnexus.clean
  budget       125 cents per run
  model        gemini-3.5-flash-lite (opus tier)
  eval suite   finance

$ trent run "Write a one-line tagline for a bakery"
· Objective: Write a one-line tagline for a bakery
[Worker] Starting job job_8xaip723r034 of type orchestration_step
· Planning...
· Plan ready
[Worker] Starting job job_tdthq9ajr03x of type orchestration_step
● [CEO] Scope objective and identify the leverage points...
    · platform_readiness check · completed
    Model call failed: No model provider API keys are configured for the allowed provider chain
✗ [CEO] Scope objective and identify the leverage points
[Worker] Starting job job_yuf9px83r0b7 of type orchestration_step
● [Engineer] Execute primary workstream with tasks:create...
    Model call failed: No model provider API keys are configured for the allowed provider chain
✗ [Engineer] Execute primary workstream with tasks:create
[Worker] Starting job job_cka8p1bpr0dd of type orchestration_step
● [CEO] Consolidate and surface the final artifact...
    · platform_readiness check · completed
    Model call failed: No model provider API keys are configured for the allowed provider chain
✗ [CEO] Consolidate and surface the final artifact
[Worker] Starting job job_y9z1zelyr0f0 of type orchestration_step
· Consolidating...
· Consolidated
✗ Run failed: every model call failed: No model provider API keys are configured for the allowed provider chain
  $0.00 · 1994ms · run orc_jqpfng19r033

$ trent budget status
  SPEND 2026-09-25 UTC
  today    $0.00 of $10.00 (0%) $10.00 left of budget.daily_cap
  nothing spent on this day
  caps     budget.per_run_cap $1.00, improve.sweep_cap_cents $1.00
  every surface appends to $TRENT_HOME/spend.ndjson
```
<!-- proof: captured verbatim from the fresh clone at 981218c with `env -i PATH HOME=<tmp> TRENT_HOME=<tmp> NO_COLOR=1 TRENT_QUEUE_FALLBACK=disabled npm run --silent cli -- <args> --no-color`; exits 0, 0, 0, 1, 0. The profile path was replaced by $TRENT_HOME. The [Worker] lines are the wrapped app's own stdout (docs/troubleshooting.md:180-184). With no key the plan is the planner's deterministic fallback, not model output. -->

`trent doctor` on the same profile afterwards:

```
  ✗ API Credentials            Active provider "google" needs GEMINI_API_KEY; the secrets file does not exist yet.
      fix: Run `trent config set GEMINI_API_KEY <your-api-key>`.
  ✗ Sandbox & Workbench        Docker is installed but the Docker daemon is not running, so the sandbox cannot start.
      fix: Start Docker Desktop, then re-run `trent doctor`.
  total 22  passed 12  warnings 3  failed 2  skipped 5  in 166ms
  2 check(s) failed — exit 3
```
<!-- proof: same clone and profile, `npm run --silent cli -- doctor --no-color`, exit 3; the two failures are this machine's (no key, Docker daemon stopped) -->

## Three crews

`trent fleet packs` lists 14 packs. Three are built for a specific kind of user, from the demand
research in `01_discovery/output/market-agents-research-2026-09-19.md`:
<!-- proof: `trent fleet packs` prints "FLEET PACKS (14)"; research doc sections 0-3 -->

| Pack | Seats and specialists | Skills | What it does today |
|---|---|---|---|
| `small-business` | support, sales, finance, content | quote-estimate, invoice-draft, booking-followup, review-response, local-business-post | Writes quotes, invoices, follow-ups, review replies and posts as files for the owner |
| `social` | content, growth, analyst, mkt-social-media-strategist, mkt-content-creator | content-calendar, brand-voice-capture, crosspost-adapt, comment-triage | Writes the calendar, posts, per-platform adaptations and comment triage as files |
| `creator` | content, mkt-short-video-editing-coach, mkt-video-optimization-specialist, design-image-prompt-engineer | hook-lab, caption-and-chapters, repurpose-plan, clip-plan, thumbnail-brief | Probes, transcribes, finds cuts, clips to 9:16 with burned captions and extracts frames on your machine when ffmpeg (and a whisper engine, for transcription) is installed; otherwise works from a transcript you supply |
<!-- proof: members and skills from `trent fleet packs`; the creator row from its "state" line there; which media binaries are present is reported by the Media Pipeline line of `trent doctor` (on the audit machine: ffmpeg, ffprobe, python3 present; whisper-cli, scenedetect missing) -->

Sending, booking, invoicing and posting are separate toolsets, `business` (Stripe, Google Calendar,
Square, Twilio) and `social` (Meta, Bluesky, Buffer, YouTube replies). Each needs `trent connect
<provider>`, the egress proxy, the toolset turned on, and your approval for every call. Both are
tested against local fake servers; neither has been run against a live account.
<!-- proof: docs/business.md:1-30 ("No test reaches a real provider", line 13); docs/social.md:1-10; docs/connect.md; the approval rule in docs/security.md:494-540. Note: `trent fleet packs` still describes these toolsets as not landed (packages/trent-core/src/fleet/FleetPacks.ts:158); audit fix 10 corrects that text. -->

## How it compares with Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is the open-source agent Trent's feature set is
measured against. Where the two differ:
<!-- proof: 01_discovery/output/hermes-feature-inventory-2026-09.md:3 ("Parity target for Trent"); docs/sessions/2026-09-2{1,2,3}-daily-parity.md -->

| | Trent (this branch) | Hermes Agent |
|---|---|---|
| Install | From a clone. A signed one-line installer is written; no release exists yet | One-line installer, native Windows, Docker, Nix, Termux; tagged releases |
| Language | TypeScript, Node 22 or Bun | Python 3.11 |
| Agent shape | Nine fixed role seats; a planner gives each step to one; 164 installable specialists | One agent that delegates to subagents (nested, parallel batches) |
| Spend | Per-run and daily caps in integer cents on one ledger for every surface; `trent run --max-cost-cents` stops a run with exit 6 | Usage and cost analytics, documented as a lower bound and off by default; turn and wall-clock budgets |
| Side effects | Send, money-moving and customer-facing calls ask at every autonomy level; the approval is bound to the exact arguments | Approval modes smart, manual, off; YOLO skips prompts except a hardline blocklist |
| Credential isolation | Egress proxy swaps an opaque token for the real key | The same design (iron-proxy) |
| Checkpoints and rollback | Yes | Yes |
| Self-improvement | Eval-gated drafts wait in quarantine; nothing goes live without `trent improve promote` | A background review writes memory and skills every few turns |
| Audit trail | Hash-chained export with a detached Ed25519 signature | Not in our inventory |
| Messaging | 8 adapters | 24+ platforms |
| Plugins | Local plugin manifests; MCP servers | Curated, SHA-pinned plugin catalog (223 entries); 65 curated MCP presets |
| Skills | 164 catalog specialists, 14 packs | 59 bundled and 149 optional skills |
| Memory | A profile brain in files, versioned with git; imports md, txt, csv, pdf, docx, xlsx | Built-in memory plus external memory providers |
| Desktop | Tauri app in the tree, not packaged | Electron app with macOS and Windows installers |
| A2A | Server only, answering A2A 0.3.0 and v1.0 methods; Hermes discovers and calls it | Server and client |
<!-- proof, Trent column: Install: README audit 1.3 (no release, installer URL 404). Language: package.json, docs/getting-started.md:11. Agent shape: `trent fleet list --json` (173). Spend: `trent budget status`; `trent --help` ("6 over --max-cost-cents"). Side effects: docs/security.md:494-540. Credential isolation: packages/trent-core/src/egress/; REPL banner "egress on :<port>". Checkpoints: docs/checkpoints.md. Self-improvement: docs/improve.md. Audit trail: docs/security.md#signed-audit-export (`trent audit export|verify`). Messaging: packages/trent-core/src/gateway/platforms/ (discord, email, homeassistant, signal, slack, teams, telegram, whatsapp). Plugins: README "Tools" table row `plugins`; docs/mcp.md. Skills: `trent fleet packs` (14). Memory: docs/brain.md; `trent doctor` "Brain Import Extractors" line. Desktop: docs/desktop.md; .github/workflows/release.yml:298-315 (desktop job disabled). A2A: packages/trent-core/src/a2a/ (no client); docs/a2a.md:25-70.
     proof, Hermes column: 01_discovery/output/hermes-feature-inventory-2026-09.md lines 21-25 (install), 21 (Python 3.11), 334-337 and 308 (subagents), 317 and 89 (cost, budgets), 383 and 385 (approvals, YOLO), 204 (iron-proxy), 78 (checkpoints), 495 (background review), 96 (24+ platforms), 698 and 250 (plugin catalog 223, MCP presets 65, skills 59/149), 232 and 456 (memory providers), 406 (desktop), 143 (A2A in and out); releases: docs/sessions/2026-09-23-daily-parity.md:32. "Not in our inventory" means the 913-line inventory has no such row, not that Hermes lacks it. -->

If you already run Hermes, Trent is reachable from it over A2A. If you need many messaging platforms,
a plugin catalog or a desktop app today, Hermes has them and Trent does not.
<!-- proof: docs/a2a.md:52-70 (discovery and calls proven live with Hermes v0.21.3, docs/sessions/2026-09-20-a2a-v1-wire.md) -->

## Not done yet

- **No release.** `https://agent.let-trent.uk/install.sh` returns 404 and no GitHub release or tag
  exists, so the installer and `trent update` have nothing to download. Run from a clone.
  <!-- proof: curl -w '%{http_code}' https://agent.let-trent.uk/install.sh -> 404; `gh release list` empty; `git tag -l` empty -->
- **The durable store needs Bun and a generated client** (see Install). Under Node, approvals and
  runs do not survive a restart.
  <!-- proof: apps/cli/src/runtime/headless.ts:211-219; the REPL warning -->
- **Keyless setup reports failure but exits 0**, and a bare `trent` with no key prints "Setup complete"
  before exiting 3 without opening the REPL.
  <!-- proof: `trent setup --mode quick </dev/null; echo $?` -> 0 with "Setup did not complete"; apps/cli/src/commands/index.ts:295 -->
- **The email gateway does not yet check the receiving server's authentication verdict**, so a forged
  `From:` is not rejected. Do not enable the email adapter until that lands.
  <!-- proof: packages/trent-core/src/gateway/platforms/email/imap.ts:24 fetches no Authentication-Results header; docs/sessions/2026-09-23-daily-parity.md section 3 item 1 -->
- **The desktop app is not packaged or signed**; `trent desktop install` has nothing to install.
  <!-- proof: release.yml:298-315; 05_release/CONTEXT.md step 5 -->
- **Live accounts.** The business and social toolsets have not been run against real providers;
  Meta, YouTube, TikTok and Google Business Profile app reviews are pending.
  <!-- proof: docs/business.md:13; docs/sessions/2026-09-23-daily-parity.md:15 -->
- **Windows.** The `windows-x64` binary is built and run on a Windows CI runner; the PowerShell
  installer has never been executed.
  <!-- proof: CI job "binaries / RUN trent-windows-x64.exe on windows-latest: success"; 05_release/output/release-checklist-v1.md step 22 -->
- **A2A** has no client, no push notifications, no `tasks/resubscribe` and no non-text parts.
  <!-- proof: packages/trent-core/src/a2a/; docs/a2a.md -->
- **Known defects in the wrapped application** are listed, not hidden:
  [docs/security.md](docs/security.md) ("Reported, not fixed") and `AGENTS.md`.

## Commands

`trent --help` lists 34 commands. The ones most people start with:
<!-- proof: `npx tsx apps/cli/src/index.ts --help` -->

```
trent                          the REPL (runs quick setup on first launch)
trent run "<objective>"        one objective, no terminal; exit 0 done, 1 failed, 3 config, 6 over --max-cost-cents, 7 waiting on approval, 130 interrupted
trent --tui                    full-screen terminal UI on the same session engine
trent doctor                   22 checks; exit 3 on a configuration failure
trent fleet packs | install <pack> | show <seat> | list
trent approvals list           everything waiting on you; approve <id> / reject <id>
trent budget status            today's spend against the caps
trent brain import <path>      md, txt, csv, pdf, docx, xlsx into the company brain
trent security audit           read-only report over this profile; exit 1 on a finding
trent a2a serve | trent acp    Agent-to-Agent server; Agent Client Protocol over stdio for editors
trent connect <provider>       stripe, google, square, twilio, buffer, meta, bluesky
```
<!-- proof: descriptions and exit codes from `trent --help` and `trent fleet --help`; extractors from the doctor's "Brain Import Extractors" line -->

## Documentation

| Page | Covers |
|---|---|
| [getting-started.md](docs/getting-started.md) | Clone to first real conversation |
| [configuration.md](docs/configuration.md) | Config schema, the yaml/env split, profiles, the env contract |
| [doctor.md](docs/doctor.md) | The 22 checks, exit codes, `--json`, `--fix` |
| [fleet.md](docs/fleet.md) | The catalog, the seats, packs, agent versions, export and import |
| [business.md](docs/business.md) | The `business` toolset: Stripe, Google Calendar, Square, Twilio |
| [social.md](docs/social.md) | The `social` toolset and what each platform allows |
| [media.md](docs/media.md) | The `media` toolset: probe, transcribe, scenes, clips, thumbnails, images |
| [connect.md](docs/connect.md) | `trent connect` and where provider credentials live |
| [skills.md](docs/skills.md) | The skills hub, the pre-install scanner and the curator |
| [tools.md](docs/tools.md) | The toolsets and progressive disclosure |
| [brain.md](docs/brain.md) | The company brain, import and recall |
| [checkpoints.md](docs/checkpoints.md) | The agent-write ledger and `/rollback` |
| [goals.md](docs/goals.md) | Standing goals with shell quality gates |
| [improve.md](docs/improve.md) | Evals, the judge model, promotion and rollback |
| [a2a.md](docs/a2a.md) | A2A on the wire, and ACP for editors |
| [gateway.md](docs/gateway.md) | The eight messaging adapters, pairing and approvals |
| [cron.md](docs/cron.md), [heartbeat.md](docs/heartbeat.md), [jobs.md](docs/jobs.md) | Schedules, the periodic check, failed jobs |
| [mcp.md](docs/mcp.md), [browser.md](docs/browser.md), [terminal.md](docs/terminal.md) | MCP servers, the browser toolset, sandbox backends |
| [desktop.md](docs/desktop.md) | The Tauri app |
| [security.md](docs/security.md) | Egress, sandbox, approvals, policy rules, redaction, audit export, known defects |
| [troubleshooting.md](docs/troubleshooting.md) | Failure modes we have hit |
<!-- proof: every file exists under docs/ at HEAD (`git ls-tree --name-only HEAD docs/`) -->

## Tests

CI runs on every push to `main` and `feature/**`: the core and CLI suite (3588 passed, 21 skipped, 370
files), the wrapped web app's suite (2829 passed, 125 skipped, 528 files), typecheck, lint, a repo
scan, and four binaries built with `bun build --compile`, each then run on its own OS.
<!-- proof: .github/workflows/ci.yml:22-30; run 35905708927 on 1d1418c, jobs "core tests (@trent/core + cli)" (job 108251106911, log: "Tests 3588 passed | 21 skipped (3609)", "Test Files 370 passed") and "web tests (apps/web)" (job 108251108294, log: "Tests 2829 passed | 125 skipped (2955)", "Test Files 515 passed | 13 skipped (528)"), "binaries / RUN trent-<target> on <os>" x4 success -->

Locally: `npx vitest run` for the core and CLI, `npm run test:web` for the web app. The rules this
repository is built under (failing test first, no claim without a command and its exit code,
`apps/web/` is read-only) are in [AGENTS.md](AGENTS.md).
<!-- proof: package.json scripts "test", "test:web"; AGENTS.md "Global invariants" -->

## License

MIT. See [LICENSE](LICENSE).
<!-- proof: git show HEAD:LICENSE -->
