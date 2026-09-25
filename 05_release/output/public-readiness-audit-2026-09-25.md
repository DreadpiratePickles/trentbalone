# Public readiness audit, 2026-09-25

What a first-time visitor and a first-time installer actually experience with Trent today, measured
rather than assumed, and the ten changes that would move that most. Companion drafts, written beside
this file: `README-draft-2026-09-25.md` and `launch-post-draft-2026-09-25.md`.

**Scope and method.** Read-only. Audited at HEAD `1d1418c`, re-checked at `981218c` after two browser
commits landed mid-audit (`git diff --quiet 1d1418c 981218c -- README.md docs .github scripts apps/cli`
exit 0, so nothing below changed). Every CLI run used a throwaway `TRENT_HOME` and a throwaway `HOME`
under the session scratchpad, `env -i` with no provider key, and `TRENT_QUEUE_FALLBACK=disabled`
unless a step says otherwise. The installer path was measured on a fresh public clone
(`git clone --depth 1 -b feature/trent-fleet-v2 https://github.com/DreadpiratePickles/trentbalone.git`,
commit `981218c`). Machine: macOS arm64, Node v26.8.2, Bun 1.4.2, Docker installed with the daemon
stopped. No secret file was opened; `gem.env` and `.env.local` were only checked for being ignored
and never committed (`git check-ignore -v`, `git log --all -- gem.env .env.local` prints nothing).

No session log was written by this audit because the brief limits new files to `05_release/output/`.
The parent session should record it in `docs/sessions/2026-09-25-parity-push.md`.

---

## 1. What a visitor sees now

### 1.1 The GitHub page (default branch `main`)

```
$ gh repo view DreadpiratePickles/trentbalone --json name,description,homepageUrl,repositoryTopics,defaultBranchRef,licenseInfo,stargazerCount,isPrivate
{"defaultBranchRef":{"name":"main"},"description":"Trent Fleet — AI cofounder platform: CLI, TUI, Desktop and Web over a 164-specialist multi-agent orchestrator.","homepageUrl":"","isPrivate":false,"licenseInfo":null,"name":"trentbalone","repositoryTopics":null,"stargazerCount":0}

$ gh api repos/DreadpiratePickles/trentbalone/readme
{"message":"Not Found", ... "status":"404"}

$ gh api repos/DreadpiratePickles/trentbalone/community/profile --jq '{health_percentage, files: ...}'
{"files":{"code_of_conduct":false,"code_of_conduct_file":false,"contributing":false,"issue_template":false,
 "license":false,"pull_request_template":false,"readme":false},"health_percentage":14}
```

- **The default branch has no README, no LICENSE and no `.github/`.** `git ls-tree --name-only origin/main`
  lists `.claude .gitignore "Bleeding Edge Agent Research Report.md" "Trent Agent Fleet Strategy.md"
  "Trent Fleet Build Prompt.md" "Trent Fleet Hermes Implementation Plan.md" "Trent Fleet UI UX Stack.md"
  app apps docs lib package-lock.json package.json packages scripts tsconfig.json vitest.config.ts`.
  The README moved to `apps/web/README.md` in `8bb51eb` ("move Trent app to apps/web/"), so the only
  README reachable on `main` is the wrapped web app's, which opens with an emoji heading and a
  `tests-1731 passing` badge (`git show origin/main:apps/web/README.md | head -12`).
- **`main` is 236 commits behind the branch and has none of its own.** `git rev-list --count
  origin/main..HEAD` = 236, `git rev-list --count HEAD..origin/main` = 0, merge base = `origin/main`
  (`f0e8a20`). Publishing the branch to `main` is a fast-forward.
- **GitHub does not detect a license** (`licenseInfo: null`) because `LICENSE` is not on `main`. The
  file exists on the branch (MIT, `git show HEAD:LICENSE`).
- **The name mismatch.** The repository is `trentbalone`; the product, the binary and every doc say
  "Trent" / "Trent Fleet". The slug is hardcoded in seven non-test places
  (`packages/trent-core/src/updater/release.ts:4,22`, `scripts/install.sh:43`, `scripts/install.ps1:70`,
  `scripts/installer/install.sh.in:43`, `scripts/installer/install.ps1.in:38`,
  `scripts/release/pages/index.html:49`), so a rename is cheap now and expensive after a release.
- **About box overclaims.** "CLI, TUI, Desktop and Web": the desktop app has no bundle and is
  deferred past v1 (`05_release/CONTEXT.md` step 5; `release.yml:298-315`), and the web UI needs
  `cd apps/web && npm run build` first (`docs/getting-started.md:255`). No topics, no homepage, 0 stars.
- **The root listing leads with planning documents.** Five strategy/prompt files with spaces in their
  names (126 KB, 50 KB, 26 KB, 23 KB, 24 KB) sit above `README.md` in the file list on both branches.
- **No screenshot, GIF or recording exists anywhere.** `git ls-files | grep -v '^apps/web/' | grep -iE
  '\.(png|jpe?g|gif|webp|svg|cast|mp4|webm|mov|tape)$'` returns only the desktop app's icons; the
  README has zero images and zero badges (`grep -cE '!\[|<img|asciinema|shields.io'` = 0). `vhs`,
  `asciinema` and `agg` are not installed on this machine.

### 1.2 The branch README, first screen (`git show HEAD:README.md`)

```
# Trent Fleet

Trent is a multi-agent AI cofounder that runs from your terminal. Nine seats (CEO, engineer,
growth, sales, content, support, analyst, finance, escalation) work a task through a real
orchestrator, share one company memory, run their tools inside a sandbox that never sees a real API
key, and improve their own prompts and skills under a human-gated loop. ...

## Install

The installer is written, tested and rendered at `scripts/install.sh` and `scripts/install.ps1`. It
is designed to be served as:

    curl -fsSL https://agent.let-trent.uk/install.sh | bash

**That URL is not live yet.** As of 2026-09-13, ...
    git clone <your remote> trent && cd trent
```

The first command a reader sees does not work, and the working path starts with a placeholder
(`<your remote>`) and, if taken literally from `main`, clones a tree with no README and a stale CLI.
The pitch is accurate but abstract: nothing on the first screen shows output.

### 1.3 The one-curl installer

| Check | Command | Result |
|---|---|---|
| Parses | `bash -n scripts/install.sh; sh -n scripts/install.sh` | exit 0, exit 0 (697 lines) |
| Downloads from | `grep -n https scripts/install.sh` | `TRENT_REPO="DreadpiratePickles/trentbalone"`; `https://github.com/$TRENT_REPO/releases/{download,latest}` (`:43-45`) |
| Served URL | `curl -o /dev/null -w '%{http_code}' https://agent.let-trent.uk/install.sh` | `404` (Cloudflare edge `172.64.80.1`); `/` also 404 |
| Release exists | `gh release list -R DreadpiratePickles/trentbalone`; `git tag -l` | empty; empty |
| `releases/latest` | `curl -w '%{http_code} -> %{redirect_url}' .../releases/latest` | `302 -> .../releases` (no release); API `404` |
| Pages site | `gh api repos/DreadpiratePickles/trentbalone/pages` | `404 Not Found`; `has_pages: false` |
| Public key committed | `git ls-files scripts/installer/keys/` | `minisign.pub` only; **`ecdsa-p256.pub.pem` is not tracked** |

**Release blocker found.** Root `.gitignore:52` (`*.pem`) ignores `scripts/installer/keys/ecdsa-p256.pub.pem`
(`git check-ignore -v` prints `.gitignore:52:*.pem`), and no commit on any ref has ever contained it.
`release.yml:98` runs `test -s scripts/installer/keys/ecdsa-p256.pub.pem`, `release.yml:107` and
`pages.yml:89` run `sh scripts/installer/render.sh --check`, and `render.sh:35` exits 2 without the
file. On a clean export of HEAD:

```
$ git archive HEAD scripts | tar -x -C $SCRATCH/headx && cd $SCRATCH/headx
$ sh scripts/installer/render.sh --check
render.sh: keys/ecdsa-p256.pub.pem missing                  # exit 2
$ test -s scripts/installer/keys/ecdsa-p256.pub.pem          # exit 1
```

So the first `v1.0.0` tag would fail `Release / preflight`, and `Pages / build` would fail too. In the
developer tree the file exists and `render.sh --check` exits 0, which is why nobody has seen it.
CI (`ci.yml`) never runs `render.sh --check`, so the green CI runs do not cover it. The public key is
already public (the rendered `scripts/install.sh` embeds it), so committing it discloses nothing.

### 1.4 Release workflows and the checklist

- `release.yml` (tag `v*` -> preflight, `binary.yml`, sign with two keys from repository secrets,
  publish nine assets) and `pages.yml` (gated on a published non-prerelease release,
  `scripts/ci/pages-release-gate.mjs`) are complete and have never run: no tag, no release.
- `binary.yml` does run in CI and is green: run `35905708927` on `1d1418c` shows the four
  `binaries / build bun-*` jobs and the four `RUN trent-* on <os>` jobs `success`
  (`gh run view 35905708927 --json jobs`).
- `05_release/output/release-checklist-v1.md`: 25 steps, 20 need Bobby. Step 4 (make the repository
  public) is already done (`isPrivate: false`), but the checklist and `docs/getting-started.md:295`
  still say the repository is private. The steps that remain Bobby's: 1 (declare phases landed),
  3 (history check), 5 (enable Pages), 6 (certificate for `agent.let-trent.uk`), 7 (repository
  secrets), 8 (merge to `main`), 10-12 (preflight, tag, push), 20-24 (smoke tests per platform).

### 1.5 The CLI, first impression

```
$ npx tsx apps/cli/src/index.ts --help          # 1.8 s, exit 0
Usage: trent [options] [command]

Trent Fleet - autonomous AI cofounder platform
...
Commands:
  run [options] [objective]     Run one objective headlessly and stream its events; ...
  doctor [options]              Run health diagnostics across config, credentials, agents and systems
  setup [options]               Run the Trent setup wizard (quick, full or blank-slate)
  ... 31 more ...
```

34 visible commands, alphabetical-by-group, with no "start here" line and no example. `setup --help`
shows `--mode <mode> quick, full or blank-slate (default: "quick")`, `--portal "Quick cloud login
setup"` (there is no hosted sign-in: `packages/trent-core/src/setup/detect.ts:107` says so), and the
REPL/TUI flags (`-c`, `--version`) repeated as if they were setup options. The README's count claims
hold: `trent --help` lists 34 commands, and walking the Commander tree gives 35 top-level entries
(34 plus one hidden), 101 second-level and 11 third-level, so 146 without the hidden alias.
`fleet list --json` returns 173 agents including all nine seats; `doctor` reports `total 22`.

### 1.6 The first run, exactly as a newcomer meets it (no key)

**Doctor on a fresh profile** (exit 3):
```
  ✗ API Credentials            Active provider "google" needs GEMINI_API_KEY; the secrets file does not exist yet.
  ✗ Sandbox & Workbench        Docker is installed but the Docker daemon is not running, so the sandbox cannot start.
  total 22  passed 10  warnings 4  failed 2  skipped 6  in 468ms
  2 check(s) failed — exit 3
```
Without `export TRENT_QUEUE_FALLBACK=disabled` (fresh clone, `npm run --silent cli -- doctor`) a third
failure appears, warning that the bill quadruples:
```
  ✗ Standalone Environment Contract The standalone environment contract is violated ... roughly quadrupling the model bill while the run still reports success.
  total 22  passed 9  warnings 4  failed 3  skipped 6  in 200ms
```
Every run surface already applies the contract itself (`packages/trent-core/src/runtime/env.ts:45`,
`apps/cli/src/commands/web-server.ts:266`); the export exists only to satisfy the doctor, which reads
the raw shell environment.

**`trent setup --mode quick`** prints the key guidance, then `Setup did not complete ... no secrets
written`, and **exits 0**. With `--json` it reports `"success": false`, also exits 0, and its stdout
is not JSON because the guidance lines are printed there first:
```
$ trent setup --mode quick --json 2>/dev/null | node -e 'JSON.parse(...)'
stdout is NOT valid JSON: Unexpected token 'N', "No provide"... is not valid JSON
```
Source: the setup handler returns `{ data: { ...summary } }` with no exit code
(`apps/cli/src/commands/groups/diagnostics.ts`), and `QuickSetup` prints through `this.say`
(`packages/trent-core/src/setup/QuickSetup.ts:35`).

**Bare `trent`** (first launch, no config) runs quick setup and prints, in success styling:
```
Setup complete: No provider key found. Set OPENAI_API_KEY (or another provider variable listed above) ... then run setup again.
```
then exits 3 without starting the REPL. `apps/cli/src/commands/index.ts:295` always uses
`ctx.theme.success("Setup complete: ...")` regardless of `summary.success`. The README's promise
("With no key, the REPL still runs but prints a `DEGRADED` banner") is only reachable after some other
command writes `config.yaml` (for example `trent config set provider google` or
`trent fleet install small-business`), after which the REPL does start and prints:
```
● 3 AGENTS READY
tools file_ops, terminal, web, code, delegation, cron, skills, plugins, human    sandbox local (docker unavailable; ...)    egress on :65151
This workspace is not trusted, so none of its instruction files were read. Run: trent workspace trust ...
This session is not durable: the SQLite store needs Bun. Approvals will not survive a restart.
◆ DEGRADED MODE — no provider key is configured.
```

**`trent setup --mode blank-slate`** with stdin not a TTY dies with a raw prompt error:
`error: User force closed the prompt with 0 null` (exit 2).

**`trent run "<objective>" --dry-run`** prints nothing and exits 0 in text mode; with `--json` it
prints the parsed options. **`trent run "<objective>"`** with no key is honest: a three-step plan
(CEO, Engineer, CEO), each model call refused, `✗ Run failed: every model call failed`, `$0.00`,
exit 1, about 2 seconds. The wrapped app's `[Worker] Starting job ...` lines are interleaved with the
run in text mode (documented in `docs/troubleshooting.md` as expected), and the fallback plan text is
generic (`Execute primary workstream with tasks:create`). `trent fleet show finance` labels the model
`gemini-3.5-flash-lite (opus tier)`, which reads as a contradiction to a newcomer.

**Durability.** The README says a run survives a process restart and that approvals, budget and the
audit chain persist in `~/.trent/trent.db`. Measured:
- Under Node (`npm run cli`, the only documented path) the store is `EphemeralStore`
  (`apps/cli/src/runtime/headless.ts:211-219` catches the `bun:sqlite` import failure); no `trent.db`
  is created and the REPL says "This session is not durable".
- Under Bun from a fresh clone it is still not durable: `bun --no-env-file` on the store module fails
  with `Cannot find module './generated/client'` because the SQLite Prisma client is gitignored
  (`packages/trent-core/src/store/.gitignore:3`) and `npm install` does not generate it. Only CI runs
  `npx prisma generate --schema packages/trent-core/prisma/schema.sqlite.prisma` (`ci.yml:193,227,266`).
- After that one command (1 s, exit 0) and `bun --no-env-file apps/cli/src/index.ts`, the REPL no
  longer prints the warning and `$TRENT_HOME/trent.db` exists. No doc tells a user this.

### 1.7 Does a visitor reach a running agent in under five minutes?

| Step | Command (fresh clone, this machine) | Time | Result |
|---|---|---:|---|
| Find instructions | open `github.com/DreadpiratePickles/trentbalone` | - | no README on `main` |
| Clone | `git clone --depth 1 -b feature/trent-fleet-v2 https://github.com/DreadpiratePickles/trentbalone.git` | 3 s | 75 MB, exit 0 |
| Install | `npm install --no-audit --no-fund` (empty npm cache) | 13 s | exit 0; `EBADENGINE` warnings because `apps/web/package.json` pins `node: 22.x` while `docs/getting-started.md:11` says "Node 22 or newer" |
| Check | `npm run cli -- doctor` | < 1 s | exit 3 |
| Setup | `npm run cli -- setup --mode quick` | ~2 s | no key: "Setup did not complete", exit 0 |
| First objective | `npm run cli -- run "Write a one-line tagline for a bakery"` | ~2 s | no key: exit 1, `$0.00` |
| Same, with a key | not measured: no key was used in this audit | - | - |

Verdict: mechanically yes, for someone who already knows to clone `feature/trent-fleet-v2` and already
holds a provider key; the steps above take under a minute. A visitor arriving at the GitHub page does
not get there: `main` shows no README, the branch README's first command 404s, and the clone line is
a placeholder. A visitor without a key sees no agent at all on first launch (exit 3).
`docs/getting-started.md` sections 6 and 8 add two more traps for a Gemini key: set
`GOOGLE_MODEL_DEFAULT` because the wrapped app's default Google model is retired.

### 1.8 Docs navigability

- No `docs/README.md` or `docs/index.md`. The README's docs table is the only index.
- It omits four user-facing pages: `docs/business.md`, `docs/connect.md`, `docs/media.md`,
  `docs/social.md` (and the rulebook), found by checking every `docs/*.md` against the README.
- Stale facts a newcomer will trip on: `README.md:26` "As of 2026-09-13"; `README.md:294-300` test
  counts from 2026-09-15 (`1765 passed`; CI now runs `3588 passed | 21 skipped (3609)` over 370 files,
  job `108251106911` on `1d1418c`); `docs/getting-started.md:295` "the repository is private";
  `docs/getting-started.md:298` and `README.md:142` `npm run build:binary`, which fails from the root
  (`npm error Missing script: "build:binary"`; it lives in `apps/cli/package.json:13`).

### 1.9 The three market personas as a demo story

The packs are the best demo material in the tree, and they work with no key:
```
$ trent fleet install small-business
  installed support, sales, finance, content
  skills  booking-followup, invoice-draft, local-business-post, quote-estimate, review-response
  persona brain/system/persona-small-business.md (written, committed)
```
`trent fleet packs` lists 14 packs; the three market ones are `small-business`, `social` and
`creator`, grounded in `01_discovery/output/market-agents-research-2026-09-19.md` (demand evidence,
section 0; ten jobs per persona, sections 1-3). Two defects in how they present:
- The `state` lines for `small-business` and `social` say sending, invoicing and posting wait "until
  the business toolset (Stripe, Google Calendar, Square, Twilio) lands" / "until the social toolset
  lands" (`packages/trent-core/src/fleet/FleetPacks.ts:158`; four skill files under
  `packages/trent-core/skills/*/SKILL.md`). Both toolsets have landed (`docs/business.md`,
  `docs/social.md`, `packages/trent-core/src/tools/{business,social}/`), tested against local fake
  servers only ("No test reaches a real provider", `docs/business.md:10-13`).
- Nothing in the README tells this story; the personas appear only inside `trent fleet packs`.

### 1.10 The honest Hermes comparison

Sources: `01_discovery/output/hermes-feature-inventory-2026-09.md` (snapshot 2026-09-18, amended by
the daily checks) and `docs/sessions/2026-09-23-daily-parity.md`.

**Not differentiators; Hermes has them too.** A credential-brokering egress proxy (Hermes
"iron-proxy", inventory line 204), a hardline blocklist and deny globs (383-387), checkpoints and
rollback over an agent-write ledger (78), a skills curator with an append-only ledger (262, 496),
three setup modes (32), A2A (143), a doctor (35), a supply-chain security audit (38), a TUI (63), MCP and cron. Leading with the egress
proxy would be answered with "Hermes shipped that".

**Differentiators the tree proves.**
1. Nine fixed role seats, each with a capability record: toolsets, denied toolsets, gated actions,
   a per-run budget in cents and an eval suite (`trent fleet show finance`, section 1.6). Hermes
   delegates to general subagents (334-337).
2. Enforced spend caps in integer cents, one ledger across every surface (`trent budget status`;
   `trent run --max-cost-cents`, exit 6). Hermes reports cost as analytics, documented as a lower
   bound and off by default (317); the inventory lists iteration and wall-clock budgets (89), not a
   spend cap.
3. Side-effecting calls (send, money, customer-facing) ask at every autonomy level, and the approval
   is bound to the exact call arguments (`docs/security.md:494-540`). Hermes has approval modes and a
   YOLO mode that bypasses prompts except the hardline list (383, 385).
4. Self-improvement never goes live without `trent improve promote` (README "Self-improvement";
   `docs/improve.md`). Hermes's background review writes memory and skills on a counter (495).
5. A hash-chained audit export with a detached Ed25519 signature (`trent audit export|verify`,
   `docs/security.md#signed-audit-export`); not in the Hermes inventory.
6. Interoperability, not replacement: Hermes's `a2a_discover` and `a2a_call` reach Trent's A2A server
   in v1.0 dialect, proven live with no model call (`docs/a2a.md:52-70`).

**What Hermes has that Trent lacks.** A live one-line installer and tagged releases (21; newest
v2026.9.21 = 0.21.4, `docs/sessions/2026-09-23-daily-parity.md:32`); native Windows, Docker, Nix and Termux installs (22-25); 24+ messaging
platforms from one process (96) against Trent's eight adapters
(`packages/trent-core/src/gateway/platforms/`); a curated, SHA-pinned plugin catalog at 223 entries
(698) against local `~/.trent/plugins/*/plugin.json` only; an Electron desktop app with macOS and
Windows installers (406) against an unpackaged Tauri app; 59 bundled plus 149 optional skills and 65
curated MCP presets (250); eight external memory providers (456); an A2A client (Trent serves only:
`packages/trent-core/src/a2a/` has no client).

**Open security item that gates a launch.** Trent's email adapter reads no authentication header
(`packages/trent-core/src/gateway/platforms/email/imap.ts:24` at HEAD fetches
`FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES`), so a forged `From:` reaches a paired
sender's agent (`docs/sessions/2026-09-23-daily-parity.md` section 3, item 1). A fix is in flight in
the working tree (`docs/sessions/2026-09-25-p1a-email-auth.md`, uncommitted). Do not post a launch
before it lands.

---

## 2. The ten highest-leverage fixes, ranked by impact over effort

| # | Fix | Owner | Effort | Unblocks |
|---:|---|---|---|---|
| 1 | Put the product on the default branch | **Bobby** | 1 command | everything a visitor sees |
| 2 | Commit the ECDSA public key; check the render in CI | Agent | 10 lines | the first release |
| 3 | Replace the README with the draft | Agent (Bobby reviews) | draft ready | first screen, first run |
| 4 | Make the keyless first run tell the truth and exit non-zero | Agent | ~20 lines + tests | first run |
| 5 | Drop the manual `TRENT_QUEUE_FALLBACK` export | Agent | ~5 lines + test | first run, every doc |
| 6 | Make the clone path durable (generate the store client; a Bun script) | Agent | ~5 lines + docs | the durability claim |
| 7 | Cut v1.0.0 and serve the installer | **Bobby** | checklist steps 5-7, 10-12 | the one-curl install |
| 8 | Settle the repo identity before the tag: rename, About, topics | **Bobby** decides; agent updates 7 slug sites | 1 hour | discovery, trust |
| 9 | Record a 60-second terminal demo | Agent (keyless parts); **Bobby** (keyed run) | 1-2 hours | the README's first screen |
| 10 | Community files and docs hygiene | Agent; **Bobby** toggles vulnerability reporting | 2-3 hours | contributors, trust |

### 1. Put the product on the default branch — BOBBY

- **Files:** none. **Change:** either publish the branch to `main` (a fast-forward: `git rev-list --count
  HEAD..origin/main` = 0), which is release-checklist step 8, or, until that is decided, point the
  default branch at the branch: `gh repo edit DreadpiratePickles/trentbalone --default-branch feature/trent-fleet-v2`.
- **Acceptance:** `gh api repos/DreadpiratePickles/trentbalone/readme --jq .path` prints `README.md`;
  `gh repo view DreadpiratePickles/trentbalone --json licenseInfo --jq .licenseInfo.spdxId` prints `MIT`.

### 2. Commit the ECDSA public key and check the clean-checkout render in CI — agent

- **Files:** `.gitignore`, `scripts/installer/keys/ecdsa-p256.pub.pem`, `.github/workflows/ci.yml`.
- **Change:** after `.gitignore:52` (`*.pem`) add `!scripts/installer/keys/ecdsa-p256.pub.pem`; stage
  exactly `.gitignore scripts/installer/keys/ecdsa-p256.pub.pem` (the private halves stay excluded by
  `scripts/installer/keys/.gitignore`: `minisign.key`, `*.key.pem`). Add a CI step
  `sh scripts/installer/render.sh --check` so a missing input fails on every push, not on tag day.
- **Acceptance:** `d=$(mktemp -d); git archive HEAD scripts | tar -x -C "$d"; (cd "$d" && sh scripts/installer/render.sh --check)`
  exits 0; `git ls-files scripts/installer/keys/` lists `ecdsa-p256.pub.pem`; `git ls-files
  'scripts/installer/keys/*.key*'` prints nothing; `scripts/release/preflight.sh` check 4 passes.

### 3. Replace the README with the draft — agent, after Bobby reads it

- **Files:** `README.md` from `05_release/output/README-draft-2026-09-25.md`.
- **Change:** lead with what a user gets in a minute, one install block that works today, one real
  transcript, the three personas, an honest comparison, and a complete docs index. Every claim carries
  its proof in an HTML comment. Update the install block when fixes 1, 5, 6 and 7 land.
- **Acceptance:** the install block, pasted into a fresh shell on a machine with Node 22 and git, ends
  with `trent doctor` printing `total 22`; every command in an HTML proof comment exits as stated.

### 4. Make the keyless first run tell the truth and exit non-zero — agent, failing test first

- **Files:** `apps/cli/src/commands/index.ts:291-297`, `apps/cli/src/commands/groups/diagnostics.ts`
  (setup action and `runSetup`), tests beside them.
- **Change:** (a) when `summary.success` is false, print `theme.error("Setup did not complete: ...")`
  instead of `theme.success("Setup complete: ...")`; (b) the setup action returns
  `exitCode: EXIT.CONFIG` when `success` is false (the pattern at `groups/mcp.ts:250`); (c) under
  `--json`, route the wizard's `say` lines to stderr so stdout is one JSON document; (d) `blank-slate`
  with no TTY exits 2 with a sentence ("blank-slate is interactive; use --mode quick or run in a
  terminal") instead of `User force closed the prompt with 0 null`. Product decision for Bobby,
  optional: let a keyless first launch write a keyless config and open the `DEGRADED` REPL, which is
  what the README promises and what a visitor without a key would want to see.
- **Acceptance:** on a keyless profile `trent setup --mode quick </dev/null; echo $?` prints `3`;
  `trent setup --mode quick --json 2>/dev/null | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))'`
  exits 0; bare `trent` prints `Setup did not complete`.

### 5. Drop the manual `TRENT_QUEUE_FALLBACK` export — agent, failing test first

- **Files:** `apps/cli/src/index.ts` (before `runCli`), then the export lines in `README.md`,
  `docs/getting-started.md` section 4 and `docs/doctor.md`.
- **Change:** `process.env.TRENT_QUEUE_FALLBACK ??= "disabled";` at CLI entry, so the doctor check
  passes for anyone using the CLI and still fails when a user explicitly set another value. The
  contract in `AGENTS.md` is satisfied in-process, as every run surface already does
  (`runtime/env.ts:45`).
- **Acceptance:** `env -u TRENT_QUEUE_FALLBACK npm run --silent cli -- doctor --json` reports the
  Standalone Environment Contract check as passed; with `TRENT_QUEUE_FALLBACK=enabled` it still fails.

### 6. Make the clone path durable — agent

- **Files:** root `package.json`, `README.md`, `docs/getting-started.md`, `docs/troubleshooting.md`.
- **Change:** add `"postinstall": "prisma generate --schema packages/trent-core/prisma/schema.sqlite.prisma"`
  (CI already runs the same command) and `"cli:bun": "bun --no-env-file apps/cli/src/index.ts"`; say in
  the README that the store is durable under Bun and in-process under Node. Until then the README draft
  states the limitation and the two commands.
- **Acceptance:** fresh clone, `npm install`, then `printf '/exit\n' | npm run --silent cli:bun --`
  prints no "not durable" line and `$TRENT_HOME/trent.db` exists (verified by hand in this audit with
  the two commands run separately).

### 7. Cut v1.0.0 and serve the installer — BOBBY (after 1 and 2; after 8 if renaming)

- **Files:** none. **Change:** `05_release/output/release-checklist-v1.md` steps 5 (enable Pages), 6
  (certificate), 7 (`gh secret set TRENT_MINISIGN_KEY` / `TRENT_ECDSA_KEY` from the key files, never
  printed), 10 (`scripts/release/preflight.sh --version 1.0.0`), 12 (annotated tag, push), then 17-23.
- **Acceptance:** `curl -fsSI https://agent.let-trent.uk/install.sh | head -1` prints `HTTP/2 200`;
  `gh release view v1.0.0 --json assets --jq '.assets|length'` prints `9`. Then the README install
  block becomes the one-liner.

### 8. Settle the repository identity before the tag — BOBBY decides, agent follows

- **Files (if renamed):** the seven slug sites listed in 1.1, then `sh scripts/installer/render.sh`
  and commit the re-rendered installers.
- **Change:** decide `trentbalone` -> `trent` (or keep it). GitHub redirects renamed repositories, but
  the installer and `trent update` resolve the slug at run time, so renaming after v1.0.0 leans on
  redirects for every install. Also: `gh repo edit DreadpiratePickles/trentbalone --description "..."
  --add-topic ai-agents,multi-agent,cli,typescript,a2a,mcp,llm --homepage https://agent.let-trent.uk`
  (homepage only once it serves), and drop "Desktop" from the description until a bundle ships.
- **Acceptance:** `gh repo view --json name,description,repositoryTopics` shows the new values;
  `git grep -n trentbalone -- scripts packages/trent-core/src apps .github` prints only tests, or nothing.

### 9. Record a 60-second terminal demo — agent for the keyless parts, Bobby for the keyed run

- **Files:** `docs/assets/first-run.tape` (a VHS script), `docs/assets/first-run.gif`, `README.md`.
- **Change:** script the transcript in the README draft (install a pack, show a seat, run, budget),
  render it, and put it under the README's first paragraph. The keyed half (a real answer, a real cost
  line) needs a key and a few cents, so Bobby records it. `vhs` is not installed here; installing it is
  a download to ask about.
- **Acceptance:** the README's first screen shows the GIF; the file is under 2 MB; every frame matches
  a command a reader can run.

### 10. Community files and docs hygiene — agent; Bobby toggles one setting

- **Files:** new `SECURITY.md` (report through GitHub private vulnerability reporting; link
  `docs/security.md` "Reported, not fixed"), `CONTRIBUTING.md` (the `AGENTS.md` rules a contributor
  needs, the two test commands, `prisma generate`), `CODE_OF_CONDUCT.md`,
  `.github/ISSUE_TEMPLATE/bug_report.yml` (asks for `trent doctor --json` and `trent --version`),
  `.github/pull_request_template.md`, `docs/README.md` (index of every page); edits to
  `docs/getting-started.md:295` (not private), `:298` and `README.md:142`
  (`npm run build:binary -w apps/cli`), `:11` or `apps/web/package.json` engines (one Node story),
  `FleetPacks.ts:158` and the social pack's `state` plus the four SKILL.md lines (the toolsets have
  landed; say what they need: `trent connect`, the egress proxy, a per-call approval); optionally move
  the five root planning files into `docs/strategy/` after checking inbound links.
- **Bobby:** enable private vulnerability reporting (repository settings).
- **Acceptance:** after fix 1, `gh api repos/DreadpiratePickles/trentbalone/community/profile --jq .health_percentage`
  is at least 85 (from 14); `grep -rn "repository is private" docs` prints nothing; every
  `docs/*.md` is linked from `docs/README.md`.

### Who does what

- **Bobby only:** 1 (default branch or merge), 7 (Pages, certificate, secrets, tag, smoke tests),
  8 (the rename and About decision), the keyed recording in 9, the vulnerability-reporting toggle
  in 10, and the product decision in 4 (keyless first launch opens the DEGRADED REPL or not).
- **An agent can land on the branch:** 2, 3, 4, 5, 6, the keyless tape in 9, the files and edits in
  10, and the slug update in 8 once the name is chosen. Each with a failing test first where it
  changes behaviour (4, 5), explicit-file staging, and no push.

### Launch gates (before the post in `launch-post-draft-2026-09-25.md` goes anywhere)

1. Fix 1 done: a visitor sees the README on the default branch.
2. The email `From:` verification fix (P1-A) committed and green.
3. Fixes 3 and 4 done, so the first screen and the first run agree.
4. Preferably fix 7, so the post can carry one install line. Without it, the post must say "run
   from a clone" in its first paragraph.

---

## 3. Gaps between what the README claims today and what the tree proves

1. **"Durable orchestration ... a run survives a process restart. Approvals, budget and the audit
   chain persist in a local SQLite database at `~/.trent/trent.db`"** (`README.md:107-109`). On the
   only documented path (`npm run cli`, Node) the store is in-process and the REPL says so; under Bun
   from a fresh clone it is still in-process because the store's Prisma client is never generated.
   Durable only with an undocumented `prisma generate` plus Bun (section 1.6).
2. **The install story** (`README.md:13-48`). The lead command 404s; there is no release; the release
   pipeline cannot pass its first step from a clean checkout because the ECDSA public key is
   gitignored; and the default branch shows no README at all (sections 1.1, 1.3).
3. **"With no key, the REPL still runs but prints a `DEGRADED` banner"** (`README.md:78-81`). A keyless
   first launch prints "Setup complete: No provider key found", exits 3 and never opens the REPL;
   `trent setup` reports failure with exit 0 and emits invalid JSON under `--json` (section 1.6).

Smaller: test counts are ten days and 1,823 tests stale; "As of 2026-09-13"; four docs missing from
the index; `npm run build:binary` from the root fails; the pack `state` lines contradict
`docs/business.md` and `docs/social.md`. Claims that did check out: 22 doctor checks, 173 agents with
all nine seats, 34 commands and 146 with subcommands, the four binaries built and run on their native
OS in CI, `trent doctor` exit 3 on a configuration failure, `trent run` exit 1 on a failed run.

---

## 4. Evidence index (commands run for this audit)

| Command | Exit | Used in |
|---|---:|---|
| `gh repo view DreadpiratePickles/trentbalone --json ...` | 0 | 1.1 |
| `gh api repos/DreadpiratePickles/trentbalone/readme` | 1 (404) | 1.1 |
| `gh api .../community/profile` | 0 | 1.1 |
| `git ls-tree --name-only origin/main`; `git rev-list --count` both ways | 0 | 1.1 |
| `gh release list`; `gh api .../pages` | 0 (empty); 1 (404) | 1.3 |
| `bash -n scripts/install.sh`; `sh -n scripts/install.sh` | 0; 0 | 1.3 |
| `curl ... https://agent.let-trent.uk/install.sh` | 404 | 1.3 |
| clean `git archive HEAD scripts` then `sh scripts/installer/render.sh --check` | 2 | 1.3 |
| same in the developer tree | 0 | 1.3 |
| `gh run view 35905708927 --json jobs`; job logs `108251106911`, `108251108294` | 0 | 1.4, 1.8 |
| `npx tsx apps/cli/src/index.ts --help`, `setup --help`, `--version`, `fleet --help`, `fleet packs` | 0 | 1.5, 1.9 |
| Commander tree walk (scratch script importing `registerCommands`) | 0 | 1.5 |
| `doctor` fresh profile, with and without the export | 3; 3 | 1.6 |
| `setup --mode quick` / `--json` / `--dry-run` keyless | 0; 0; 0 | 1.6 |
| bare `trent` keyless, first launch | 3 | 1.6 |
| `setup --mode blank-slate` non-TTY | 2 | 1.6 |
| `run "<objective>"` keyless; `--dry-run`; `--dry-run --json` | 1; 0; 0 | 1.6 |
| REPL after `config set provider google` | 0 | 1.6 |
| Bun store probe in the clone; `npx prisma generate --schema ...sqlite.prisma`; Bun REPL | 1; 0; 0 | 1.6 |
| `git clone --depth 1 -b feature/trent-fleet-v2 ...`; `npm install` | 0; 0 | 1.7 |
| `fleet install small-business`; `fleet show finance`; `budget status`; `a2a card finance` | 0 | 1.9, drafts |
