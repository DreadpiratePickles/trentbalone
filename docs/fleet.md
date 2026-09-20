# Fleet

The catalog holds 164 specialists across 13 divisions, plus 9 core seats. It is data in the wrapped
application (`apps/web/lib/agent-catalog.ts`), not prompts generated at runtime.

```bash
npm run cli -- fleet list
npm run cli -- fleet list --json
npm run cli -- fleet list --category engineering
npm run cli -- fleet list --installed
npm run cli -- fleet status
```

`fleet list --json` reports `{ count, total, agents }` with 173 agents: the 164 specialists plus the
9 core seats. `fleet status` reports the catalog size on its own:

```
FLEET STATUS
  active 4  installed 4  catalog 164
  budget 0.00 / 10.00
```

## The nine core seats

From `CORE_ROLES` in `packages/trent-core/src/fleet/AgentInstaller.ts`. Descriptions are quoted from
the source, not written for this page.

| Id | Name | Division | Does |
|---|---|---|---|
| `ceo` | CEO Agent | executive | Prioritizes strategy, roadmap, risks, and operating cycle summaries |
| `engineer` | Lead Engineer | engineering | Plans code changes, GitHub work, tests, and technical architecture |
| `growth` | Growth Hacker | marketing | Designs acquisition experiments, campaigns, and funnel improvements |
| `content` | Design & Content Lead | design | Creates design direction, landing copy, docs, and creative briefs |
| `support` | Support & Ops Responder | support | Drafts replies, mines customer feedback, and handles operations |
| `analyst` | Market & Data Analyst | product | Researches markets, competitors, and revenue metrics |
| `finance` | Finance & Treasury Lead | finance | Tracks spend, margins, budget caps, and financial runways |
| `escalation` | Critic & Compliance Auditor | specialized | Critiques plans and audits risk before irreversible execution |
| `sales` | Sales | sales | Researches prospects, qualifies pipeline, and drafts approved outbound/follow-up material |

Install them together with `fleet install core-roles --pack`.

The nine ids are exactly the nine roles a plan step can be assigned to (`AgentRole` in
`apps/web/lib/types.ts`), and a test asserts that equality so the two rosters cannot drift.

`sales` replaced `browser` on 2026-09-18. `browser` had been listed here as a seat —
"Autonomous Web Navigator" — although no such execution role exists, so no plan step could ever
run on it, while `sales`, which does exist, was missing. **Browsing is a toolset, not a seat**:
any seat can use it once it is enabled, and every seat keeps its own prompt, skills and budget
while doing so.

```bash
npm run cli -- tools --enable browser
```

See [browser.md](browser.md) for what that toolset contains and what it needs on the machine.

The `sales` seat's name, description, model policy, per-run cap and skills are read from the
wrapped application at load time (`apps/web/lib/agents.ts` and `SLOT_ENVIRONMENTS.sales` in
`apps/web/lib/agent-catalog.ts`) rather than restated in the CLI, so the roster cannot describe
the seat differently from the seat that runs. Its per-run cap is therefore the app's 225 cents.

## What makes a seat a seat

A seat is not a prompt with a different name on it. Nine differences are enforced by the wrapper,
and every one of them is read from the application's own manifests — `SLOT_ENVIRONMENTS`
(`apps/web/lib/agent-catalog.ts`) for capabilities, gates and the per-run cap, `SEAT_MANIFESTS`
(`apps/web/lib/seat-manifest.ts`) for the model tier. There is no second roster:
`packages/trent-core/src/fleet/seat-capabilities.ts` derives, it does not restate.

```bash
npm run cli -- fleet show finance          # and --json
```

```
SEAT FINANCE — Finance/Ops Controller
  toolsets     browser, cron, delegation, human, mcp, memory, plugins, skills, vision, web
  denied       file_ops, terminal, code
  unavailable  Stripe, usage:read, billing:read
  budget       125 cents per run
  model        <configured model> (opus tier)
  eval suite   finance
```

### Toolsets, from the manifest

Each capability string a seat's manifest names maps onto one of Trent's toolsets. A capability
with no mapping has no executor in the CLI: it is reported `unavailable` and removed from the
seat's advertised tool list, so no seat is ever told it has a tool that would answer "credentials
are not configured".

| Manifest capability | Trent toolset |
|---|---|
| `documents:write`, `reports:create` | `file_ops` |
| `Workbench Sandbox`, `workbench:session` | `terminal` |
| `sandbox:exec`, `tests:run` | `code` |
| `memory:read`, `Vault Memory`, `vault:read`, `vault:write`, `vault:graph`, `gitnexus:search`, `gitnexus:context` | `memory` |
| `Steel Browser`, `steel:sessions`, `steel:screenshot` | `browser` |
| `steel:scrape`, `steel:pdf`, `prospects:research` | `web` |
| `approvals:request`, `approvals:create` | `human` |
| `Email`, `Stripe`, `GitHub`, `github:*`, `X`, `PostHog`, `Sentry`, `crm:read`, `crm:update_draft`, `email:draft`, `social:draft`, `ads:draft`, `analytics:read`, `usage:read`, `billing:read`, `support:inbound_email`, `tasks:create`, `tasks:block`, `audit:create` | none — `unavailable` |

`skills`, `delegation`, `cron`, `plugins`, `mcp`, `vision`, `human` and `memory` are the wrapper's
own capabilities, which the application's manifests do not model at all; every seat may use them
when they are enabled. The five the manifests DO decide — `file_ops`, `terminal`, `code`, `web`,
`browser` — are the capability differences between seats, and `fleet show` prints the ones a seat
is denied. The finance seat's manifest names no sandbox, so finance cannot run a shell; the
engineer's does, so it can.

### Approval floors are absolute; a seat may be stricter

The approval floors (`packages/trent-core/src/tools/approval-floors.ts`) and the hardline
blocklist apply at every autonomy level and are never relaxed for a seat. What a seat adds on top
is its own manifest gates, plus the toolsets it is denied outright. Denial is one-way: a seat
never gains a toolset its manifest did not name, and never loses a floor.

### The per-run budget, in integer cents

`budgetCentsPerRun` used to be rendered into the prompt and set on the subtask and compared to
nothing. The wrapper's seat-guard port sees every seat call's cost, so it now keeps one purse per
seat per run (`packages/trent-core/src/orchestrator/seat-guard-budget.ts`). A call is never
pre-billed — no one knows a turn's cost before the provider answers — but the moment a seat's
accumulated spend passes its cap, the seat's loop is aborted: the next call never reaches a model,
the step ends `failed`, and one `step_note` event names the spend and the cap in integer cents.

```
escalation seat budget exceeded: spent 120 cents against a per-run cap of 75 cents
```

Caps differ by seat because the manifests differ: engineer 500, analyst 350, ceo and growth 250,
sales 225, content 175, support 150, finance 125, escalation 75.

### Model tier per seat

The application routes a seat to a `haiku`/`sonnet`/`opus` tier and resolves that tier through the
per-provider `*_MODEL_FAST` / `*_MODEL_DEFAULT` / `*_MODEL_STRONG` variables. The CLI used to write
the single configured model into all three, so every seat ran the same model whatever its manifest
said. It now maps the configured tiers instead:

| Config | Tier | Variable |
|---|---|---|
| `models.fast` | `haiku` | `<PROVIDER>_MODEL_FAST` |
| `models.executor` | `sonnet` | `<PROVIDER>_MODEL_DEFAULT` |
| `models.planner` | `opus` | `<PROVIDER>_MODEL_STRONG` (and `OPENAI_MODEL_CRITIC`) |

A tier nothing configures falls back to `models.executor`, and then to the single `model` key, so a
profile that names one model still works exactly as before. An operator's own environment variable
still wins over the config file. The OpenAI-compatible aliases (`ollama`, `lmstudio`, `deepseek`,
`groq`) still resolve to `openai` plus a base URL; their tiers are written before the alias fills
the rest, so aliasing and tiering compose.

Known gap, reported rather than absorbed: `apps/cli/src/runtime/headless.ts` forwards only
`provider`, `model` and `model_overrides` into the orchestrator's model block, so a `models:` block
in the profile reaches `fleet show` but not yet a run. One line in that file (owned elsewhere)
closes it.

### One eval suite per seat

Every seat carries `evalSuiteId`, which is the seat id itself: suites are built from that seat's
own promoted failure goldens (plan decision 4, goldens only), so the improve loop looks a seat's
suite up by seat id instead of through `getCatalogAgent(...)?.skills`, which returns nothing for
every seat id.

## Divisions

Counted from `fleet list --json` on this repository. The counts cover all 173 rows, so each core seat
appears inside its division — including `executive`, which is the ceo seat's own category and holds
no catalog specialist, and which earlier revisions of this page left out of the table.

| Division | Agents |
|---|---:|
| specialized | 42 |
| marketing | 31 |
| engineering | 30 |
| design | 9 |
| sales | 9 |
| testing | 8 |
| support | 7 |
| paid-media | 7 |
| finance | 6 |
| product | 6 |
| project-management | 6 |
| spatial-computing | 6 |
| academic | 5 |
| executive | 1 |

That totals 173. Subtract the nine core seats and the catalog is exactly 164, asserted by
`packages/trent-core/src/agents/catalog.test.ts`, which also checks the ids are unique and the
per-division head counts sum correctly.

Importing the agents wrapper runs `assertSkillsInstalled` at module evaluation time, so it also
validates that every skill the catalog references exists in `lib/data/skill-agent-map.json`. That is
a deliberate fail-fast: a catalog entry pointing at a missing skill breaks the import rather than
failing later at run time.

## Installing and deploying

```bash
npm run cli -- fleet install eng-ai-engineer
npm run cli -- fleet deploy eng-ai-engineer
```

`install` provisions the agent's tools, skills and model policy into the active profile. `deploy`
promotes an installed agent onto active duty, which is what puts it in the orchestration loop.

## Packs

```bash
npm run cli -- fleet packs
npm run cli -- fleet install small-business
npm run cli -- fleet install engineering --pack
npm run cli -- fleet install all --pack
```

`fleet packs` lists every pack with its members, its skills, its persona path and a `state` line
that says what executes today. `fleet install <id>` treats an exact pack id as a pack when no
seat or specialist has that exact id; `--pack` forces it for the names a seat shares (`finance`,
`support`). `--dry-run` names the members, skills and persona it would install and writes nothing.

Grouping packs: `engineering`, `marketing`, `finance`, `support`, `executive`, `eng-trio`,
`growth-engine`, `revops`, `security-audit`, `core-roles`, `all`. Their state line is derived from
the membership: seats run in the planner; specialists install a profile and skills the seats can
read and are never scheduled on their own.

`all` installs the 164 specialists. It used to be labelled "164 specialists" and install nine core
roles; the core roles are now their own pack, and a test asserts the `all` pack's agent list is
exactly 164 long and that its name contains the number it promises.

### The three market packs

A market pack is a crew over existing seats, a set of trade skills, and a persona; it is not a
new agent, and the planner still routes work to the nine seats. Installing one does three things:
installs the members, installs the pack's skills into the profile store (every seat sees them
through `skills_list`; uninstalling a member leaves them), and writes the persona to
`brain/system/persona-<pack>.md` through the brain's own write path (committed when the brain is
versioned, left alone when the bytes are unchanged, skipped when `brain.enabled` is false). The
persona rides the stable tier of every prompt, so it is bounded at 1,800 characters and its bytes
never change between runs.

| Pack | Members | Skills | State today |
|---|---|---|---|
| `small-business` | `support`, `sales`, `finance`, `content` | `quote-estimate`, `invoice-draft`, `booking-followup`, `review-response`, `local-business-post` | Drafts only. Quotes, invoices, follow-ups, review replies and posts are written as files for the owner to send. Nothing is sent, booked, invoiced or posted until the business toolset (Stripe, Google Calendar, Square, Twilio) lands; each of those will then need the owner's approval. |
| `social` | `content`, `growth`, `analyst`, `mkt-social-media-strategist`, `mkt-content-creator` | `content-calendar`, `brand-voice-capture`, `crosspost-adapt`, `comment-triage` | Drafts and plans only. No account is connected and nothing is published or replied to until the social toolset lands, after the business and media toolsets; publishing will need approval per post. |
| `creator` | `content`, `mkt-short-video-editing-coach`, `mkt-video-optimization-specialist`, `design-image-prompt-engineer` | `hook-lab`, `caption-and-chapters`, `repurpose-plan`, `clip-plan`, `thumbnail-brief` | Clipping, transcription and thumbnails work when a media backend is installed (ffmpeg on PATH or `trent sandbox build --media`; the Media Pipeline line of `trent doctor` says which) and the `media` toolset is on: the skills call `media_probe`, `media_transcribe`, `media_scenes`, `media_clip`, `media_thumbnail` and `media_image` with the arguments spelled out, and `clip-plan` ranks a long recording into clip candidates with the exact `media_clip` call each. A `media_image` render costs cents and asks. Without a backend the crew works in text from a transcript the owner supplies. Nothing is uploaded or published. |

The personas ("The Counter Crew", "The Signal Crew", "The Cutting Room") give each member a voice,
a signature move, a refusal and a handoff, all within what the seats can do today: they draft,
the owner sends. Read one with `trent brain show system/persona-small-business.md`.

### Skill sources

Skills come from two directories in a fixed order: the app bundle `apps/web/.agents/skills/`
(read-only) and the core source `packages/trent-core/skills/`, both in the Agent Skills layout
(`<name>/SKILL.md` with `name`, `description`, `category`, `trust`, `version`, `author` and `tags`
in the frontmatter, `references/` beside it). The app is read first, so on a name collision its
copy wins and nothing in core can shadow a catalog skill. The fourteen pack skills live in the
core source; each one says when to use it, what it needs, the exact output format, a worked
example, and, wherever money, publishing or customer contact is involved, that the seat drafts
and a human sends. The five creator skills name the media tool calls they make when the media
backend is installed (docs/media.md) and say what they do without one.

## Custom agents

```bash
npm run cli -- fleet create my-analyst \
  --name "Revenue Analyst" \
  --role analyst \
  --category finance \
  --budget 1.00
```

`--budget` is in USD at this boundary and is stored as integer cents. See
[configuration.md](configuration.md).

## Versions, promote and rollback

An agent definition — the prompt the seat reads, the configured model, its toolsets and the skill
bodies it carries — can be snapshotted as an immutable, numbered version. Exactly one version per
agent is live; the rest are candidates or archived.

```bash
npm run cli -- fleet versions engineer --snapshot   # file the current definition as the next candidate
npm run cli -- fleet versions engineer              # every version, highest first, with the live one marked
npm run cli -- fleet promote engineer 2             # candidate -> live; the previous live is archived
npm run cli -- fleet rollback engineer              # the previous live version returns
```

`promote` is a human command, like `improve promote`: it writes an iteration of kind `agent` and a
ledger row to the same improve ledger, carrying the previous and new version ids, so `improve
rollback <iterationId>` and `fleet rollback <id>` are the same operation. An archived version is
never promoted again — versions are immutable — so the way back to one is a new candidate, which
keeps the history linear. `--dry-run` reports what would happen and writes nothing.

Runs are pinned. At every `run_start` the runtime records the live version id of each agent (and the
skill bodies that version carries) into the run. A promotion made while a run is in flight changes
the next run, never the one that already started — the same per-run freeze the fleet memory prelude
uses. The snapshot is `runtime.versionPins.pinnedFor(runId)` (present when the profile store is durable).

Versions live in the profile's `trent.db` (the `AgentVersion` table, beside the improve loop's
tables). Under a runtime without bun:sqlite the commands still answer, from a process-local store.

## Export and import

```bash
npm run cli -- fleet export engineer ./engineer-v2
npm run cli -- fleet import ./engineer-v2
```

`export` writes the agent's live version (or its newest candidate, or a fresh snapshot when it was
never versioned) as a directory:

```
engineer-v2/
  agent.json                 schema, agentId, version, prompt, model, toolsets, hashes, skill slugs,
                             and the seat record: name, toolsets, denied, approvalGates, budgetCents,
                             modelTier, evalSuiteId (from the application's manifest for a seat;
                             from the installed record for a custom agent; never invented)
  skills/<slug>/SKILL.md     one file per skill the version carries
  skills/<slug>/<bundle>/    the skill's references/ scripts/ assets/ tools/ when the profile holds them
```

`import` restores the seat record onto the agent's record (`agents/<id>.json`, `seat` block) and
takes the per-run cap from it, in integer cents; a bundle written before the block existed still
imports, with the profile's default cap.

`import` reads the whole bundle, runs the [pre-install scan](skills.md#the-pre-install-scan) over the prompt in
`agent.json` and over every `SKILL.md`, and refuses on any finding before a single write. The error
names the file and the scanner's category, never the offending text. What passes is filed as a NEW
candidate version — never live; `fleet promote` is the human step — and the agent's record and its
skill files land in the profile so `fleet deploy` can seat it. Exporting the imported agent from the
fresh profile reproduces `agent.json` byte for byte.

## Exporting to Claude Code and Grok Build

```bash
npm run cli -- fleet export engineer --target claude --out ./engineer-claude
npm run cli -- fleet export executive --target claude --out ./exec-crew     # a pack
```

Implemented in `packages/trent-core/src/fleet/export-claude.ts`. The output is a directory a
Claude Code user copies into a project; Grok Build reads the same files
(`[compat.claude]`, research 1d), so one export serves both:

```
engineer-claude/
  .claude/agents/engineer.md   the subagent: frontmatter name, description, tools; body below
  .mcp.json                    the `trent` server: trent mcp serve --stdio --profile <profile>
  skills/<slug>/SKILL.md       every skill the seat carries, in the Agent Skills layout, Trent's
  skills/<slug>/<bundle>/      own fields (trust, status, created_by, ...) under metadata.trent,
                               references/ scripts/ assets/ tools/ copied
  agent.json + skills/         the plain bundle too, so `fleet import` reads it back
```

The subagent file's `tools:` line names only MCP tools the `trent` server exposes for the seat's
toolsets, as Claude Code names them (`mcp__trent__read_file`, `mcp__trent__terminal`, ...); a
seat whose manifest has no `terminal` (finance) gets no terminal tool. `model` is left out: the
host chooses. The body carries, in order, the pack persona (when a pack is exported and
`brain/system/persona-<pack>.md` exists in the profile), the seat prompt of the exported version,
"What Trent asks before doing" (the `needs_approval` result and `trent approvals approve <id>`,
the hardline rules, the approval floors, the seat's manifest gates and per-run cap, all read from
the code, and the sentence that says the cap, floors, evals and pins are enforced by the running
Trent, not by the file), and the skills as a bulleted index.

A pack id exports one subagent per member that is a seat of the application or an agent installed
in this profile; members that are neither are listed as skipped, never invented. Each member's
plain bundle lands under `agents/<id>/`, the project's `skills/` is the union. Every file is text
the profile already holds; nothing in it is a canned answer, and the tools only do anything while
`trent mcp serve` is running with the gates behind it ([mcp.md](mcp.md#trent-as-an-mcp-server)).

## Exporting to Hermes and Codex

```bash
npm run cli -- fleet export engineer --target hermes --out ./engineer-hermes
npm run cli -- fleet export small-business --target hermes --out ./counter-crew   # a pack: one profile per member
npm run cli -- fleet export engineer --target codex --out ./engineer-codex
```

Both renderers share `packages/trent-core/src/fleet/export-host.ts` (which agents a target names,
the pack persona, the approval rules read from the code, the skills in the Agent Skills layout)
and each is a pure function over the seat record (`renderHermesProfile`, `renderCodexAgent`), so
the same version renders the same bytes twice.

### Hermes: a profile distribution per seat

Implemented in `packages/trent-core/src/fleet/export-hermes.ts` against the
[profile distribution](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions)
format and the installed Hermes's own loader (`hermes_cli/profile_distribution.py`,
`profiles.py`). A Hermes profile is one agent, so a pack exports one profile per seat member
under `<dir>/<id>/`:

```
engineer-hermes/
  distribution.yaml          name trent-engineer, version <seat version>.0.0, description,
                             env_requires, distribution_owned (the files below and skills/)
  SOUL.md                    the pack persona, the seat prompt, "What Trent asks before doing",
                             the skills index
  config.yaml                platform_toolsets.cli, agent.disabled_toolsets, mcp_servers.trent
  mcp.json                   the same server in the Agent Plugins shape Hermes's plugin loader reads
  README.md, .env.EXAMPLE
  skills/<slug>/SKILL.md     the skills in the Agent Skills layout, Trent's fields under
  skills/<slug>/<bundle>/    metadata.trent, references/ scripts/ assets/ tools/ copied
  trent-engineer.tar.gz      the profile under one top-level directory
  agent.json                 the plain bundle too, so `fleet import` reads it back
```

```bash
hermes profile install ./engineer-hermes --name trent-engineer   # a directory with distribution.yaml at its root
hermes profile import ./engineer-hermes/trent-engineer.tar.gz    # or the archive
hermes -p trent-engineer chat
```

The toolsets are mapped by name: the names Hermes shares with Trent (`terminal`, `web`,
`browser`, `vision`, `memory`, `delegation`, `skills`) pass through one to one; the four Hermes
spells differently are translated by a table that is data (`file_ops` to `file`, `code` to
`code_execution`, `cron` to `cronjob`, `human` to `clarify`); the ones Hermes has no toolset for
(`plugins`, `mcp`, `media`, `business`, `social`) reach the profile only through the `trent`
server, which `config.yaml` lists by its bare name so the seat's Trent tools stay on. A seat whose
manifest has no `terminal` (finance) gets Hermes's `terminal` in `agent.disabled_toolsets`. No
`model` is written: the host chooses. `env_requires` names the `trent connect` env names of the
providers the seat's toolsets execute against (`business`: Stripe, Google, Square, Twilio;
`social`: Buffer, Meta, Bluesky), every one optional, never a value: they live in the Trent
profile's secrets, and Trent does not read the Hermes profile's `.env`. Memory never travels:
Hermes hard-excludes `memories/`, and the brain stays with the running Trent.

`hermes import-agent` is not the entry point: it reads Claude Code and Codex trees (instruction
files, permission rules, MCP servers, skills) and not `.claude/agents/*.md`, `.codex/agents/*.toml`
or a profile. The live proof (`export-hermes.live.test.ts`, `TRENT_TEST_LIVE=1`, skipped by
name when no `hermes` is on the PATH) imports the archive and installs the directory into a real
Hermes, lists both, reads the manifest back with `hermes profile info`, and deletes them.

### Codex: a custom agent per seat

Implemented in `packages/trent-core/src/fleet/export-codex.ts` against the
[custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md) page and the
[config reference](https://learn.chatgpt.com/docs/config-file/config-reference):

```
engineer-codex/
  .codex/agents/engineer.toml   name, description, developer_instructions (persona, seat prompt,
                                what Trent asks before doing, skills index), [mcp_servers.trent]
  AGENTS.md                     every exported agent, the [mcp_servers.trent] snippet for
                                ~/.codex/config.toml, the approval rules, the skills index
  .agents/skills/<slug>/        the skills where Codex looks, in the Agent Skills layout
  agent.json + skills/          the plain bundle too, so `fleet import` reads it back
```

An agent file is a config layer for the spawned session, which is why it may carry
`mcp_servers`; the same table is repeated in `AGENTS.md` for the parent session. The TOML is
written by a small emitter (basic strings, string arrays, a multi-line basic string for the
instructions) and the test parses it back. **The caveat is OpenAI's own**: the custom-agent
docs say "the format may evolve as authoring and sharing mature", so the keys written are
exactly the ones the docs name today (`name`, `description`, `developer_instructions`,
`mcp_servers`) and nothing else; regenerate from Trent rather than editing by hand. `model` is
left out here too.

What neither host can carry is the same as for Claude Code: the cap, the floors, the evals and
the version pins are enforced by the running Trent the server entry points at, and every file
says so.

## Colour

An agent line renders as `● [Name]`. The dot carries state colour, the name carries division colour,
and state outranks identity: an agent waiting on a human turns ember regardless of its division. Two
divisions collide with the state signals — `marketing` is the ember hex and `product` is the pulse
hex — so those two are demoted to mist rather than being allowed to read as a state.

## Not yet implemented

- A marketplace install flow. `packages/trent-core/src/marketplace/` wraps the application's
  marketplace module but no CLI command exposes it.
