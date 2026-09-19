# Upgrade agents audit: assistant, social-media manager, creator (2026-09-19)

Read-only audit of branch `feature/trent-fleet-v2` at `8caad65`. No model was called; every claim
cites a file:line in this checkout. "ABSENT" means the grep in section 8 found nothing.

## 0. Summary

- A catalog specialist is a metadata row (id, name, specialties, whenToUse) plus skills resolved
  from its CATEGORY; none of the 164 carries a prompt, tools, model policy or eval suite of its own.
  In the CLI a specialist is never scheduled: only the nine seats run, and a specialist never
  produces traces, so the improve loop never touches it.
- A seat is the real unit of capability: `SLOT_ENVIRONMENTS` (tools, gates, budget, skills) plus
  `SEAT_MANIFESTS` (model tier, methodology, contracts) plus `agentSystemPrompt(role)`. Adding a seat
  means extending the `AgentRole` union and 25 exhaustive `Record<AgentRole, ...>` tables.
- The hosted web app already has live posting/reply/inbox/analytics adapters for X, Facebook,
  Instagram, LinkedIn, TikTok and YouTube, a content calendar, OAuth stores, and image/video/audio
  generation routers. None of it is wrapped into `@trent/core`, so the CLI can execute none of it.
- Media processing is ABSENT everywhere: no ffmpeg, no transcription (`voice/` throws by design),
  the sandbox image is alpine + python3 + node with no packages and no network.
- Booking, quotes, customer invoicing and review management for a small business are ABSENT.
- Cheapest honest packaging: all three as FLEET PACKS of existing seats plus new skill dirs, with
  the social manager riding the `content`/`growth` seats and the app's social adapters, and the
  creator limited to text deliverables until a media toolset exists.

## 1. How a specialist and a seat are defined today

### 1.1 Catalog specialist (`apps/web/lib/agent-catalog.ts`)

| Field | Where | Populated for how many of 164 |
|---|---|---|
| `id, name, emoji, category, specialties, whenToUse, color, file` | type at `agent-catalog.ts:22-56`; rows `60-1714` | all |
| `skills` | assigned at import from the category map, `agent-catalog.ts:1716-1721` via `resolveSkillsForAgent` (`apps/web/lib/agent-skills.ts:18-23`) | all, by category (`apps/web/lib/data/skill-agent-map.json`: 72 `availableSkills`, 13 `categoryDefaults`, 65 `overrides`) |
| `specialistPrompt, designedTools, modelPolicy, evalSuite, reversibilityMatrix, memoryPlan` | only in `V3_AGENT_OVERRIDES` (`agent-catalog.ts:2068-2136`) | 3 (`eng-code-reviewer`, `mkt-seo-specialist`, `spec-agents-orchestrator`), and only through `getCatalogAgentV3` (`:2138`), never on `AGENT_CATALOG` itself (grep in the array body: 0 hits for each field) |
| `file` (agency-agents markdown path) | `agent-catalog.ts:55` | never read anywhere (grep `.file` in catalog, agents, runtime: 0); the bodies are not bundled (find `engineering-code-reviewer.md`: 0) |

Prompt source at run time (web app): `apps/web/lib/agent-runtime.ts:70-110` layers
`Specialties: ...` / `When to use: ...` and `v3Profile?.specialistPrompt ?? ""` onto the SEAT prompt
of the slot the specialist is plugged into. In the improve loop
(`packages/trent-core/src/improve/seat-prompt.ts:23-29`) the specialist prompt is
`getCatalogAgent(agentId)?.specialistPrompt`, which is the non-V3 lookup, so it is `undefined` for
all 164 and the base is the seat prompt alone (`seatRoleFor` defaults to `engineer`, `:18-21`).

### 1.2 Seat (three tables, one union)

- Union: `AgentRole` = ceo, engineer, growth, content, support, analyst, finance, escalation, sales
  (`apps/web/lib/types.ts:48-57`).
- Capabilities: `SLOT_ENVIRONMENTS` (`agent-catalog.ts:1977-2050`): `tools` (capability strings),
  `approvalRequiredFor`, `budgetCentsPerRun`, `maxRuntimeSeconds`, `outputContract`, `skills`; each
  seat also receives the Steel and Vault tool/gate sets (`:1848-1875`, `withSteelTools`/`withSteelApprovalGates` `:1969-1975`).
- Model tier and contracts: `SEAT_MANIFESTS` (`apps/web/lib/seat-manifest.ts:109-198`), built by
  `seat()` (`:214-320`): `modelTier` haiku/sonnet/opus, `qualityLabel`, `methodology`,
  `toolUseStrategy`, contracts, `evalRubric`, and a `SeatToolSpec` per tool whose auth/reversibility/
  approval are INFERRED from the tool name (`inferToolExecutionMode` `:338-343`, `inferToolAuth` `:345-351`).
- Prompt: `agentSystemPrompt(role)` (`apps/web/lib/agents.ts:88-`) = shared base + a per-role
  `specifics` block (`:104`); `buildSeatSystemPrompt` (`seat-manifest.ts:359`) renders the manifest.
- Verifier: `seatOutputSchemas` (`apps/web/lib/seat-output-schemas.ts:12`) and
  `MISSION_SEAT_CONTRACTS` (`apps/web/lib/agent-mission-contracts.ts:142`) are exhaustive per role.
- CLI enforcement (`packages/trent-core/src/fleet/seat-capabilities.ts`): each seat's capability
  strings map to Trent toolsets through `CAPABILITY_TOOLSETS` (`:36-64`); the floor every seat gets
  is `SHARED_SEAT_TOOLSETS` = skills, delegation, cron, plugins, mcp, vision, human, memory (`:71`);
  `GATED_TOOLSETS` = file_ops, terminal, code, web, browser (`:74`); anything unmapped is recorded
  `unavailable` (`:106-124`). Tests: `seat-capabilities.test.ts:26-29` (exactly 9 seats),
  `:51-60` (unmapped capabilities are `unavailable`, sales names `crm:read` and `Email`).
- Count of exhaustive `Record<AgentRole, ...>` tables outside tests: 25 (grep, section 8), plus
  15 `Partial<>` ones. Adding a seat touches all 25 or `tsc` fails.

### 1.3 What `trent fleet install <id>` actually does

`apps/cli/src/commands/groups/fleet.ts:133-153` -> `FleetManager.install` ->
`AgentInstaller.install` (`packages/trent-core/src/fleet/AgentInstaller.ts:288-326`):

1. `findAgent` (`:200-242`): exact core-role id, catalog id, prefixed id or name; a substring query
   resolving to more than one specialist throws (test `AgentInstaller.test.ts:55-71`).
2. Builds the record. A seat: `fromCoreRole` (`:244-261`) -> tools = `CORE_ROLE_TOOLS` (file_ops,
   terminal, `:72-75`), skills only for `sales` (`:146-147`; the other eight `CORE_ROLES` rows
   `:79-135` have no `skills`), budget from `budgetCapCents` or `budget.per_run_cap`. A
   specialist: `fromCatalog` (`:263-280`) -> tools = `designedTools` (empty for all 164, section
   1.1), skills = category defaults, `modelPolicy` "balanced", base cap.
3. `SkillProvisioner.plan` scans every skill body with `SecurityScan` before any write, then
   `commit` materialises `<profile>/skills/<slug>.md` from `apps/web/.agents/skills/<slug>/SKILL.md`
   (`SkillProvisioner.ts:44-58`, `:74`); the flat form migrates to the directory store on first
   read (commit 5f9e149). Test: `AgentInstaller.test.ts:77-` (skills materialised, dangerous body
   refused before any write).
4. Writes `<profile>/agents/<id>.json` and adds the id to `config.fleet.installed_agents` and
   `active_agents` (`:314-324`).

What it does NOT do: nothing in `orchestrator/`, `runtime/` or `agent-runner/` reads
`config.fleet.active_agents` (grep, section 8); `seat-wiring.ts:70-88` assigns `trent-slot:<role>`
to every seat, so an installed specialist never runs under its own id in the CLI. The record's
`skills` reach a run only because the `skills` toolset lists the profile store
(`tools/skills/index.ts:1-9`, `store.ts:50`). `trace-writer.ts:41-47` says it plainly:
`resolveAgentId` "defaults to the role, which is what the standalone CLI has".

`trent fleet create <id>` (`fleet.ts:207-262`) writes a custom record with `skills: []`, two tools,
`budget_cap_per_run` in dollars and no `budget_cap_per_run_cents`, and no prompt field; it is not
read by any run either.

## 2. Coverage per new agent

Skill locations: bundled tree `apps/web/.agents/skills/` (113 dirs); assignable set
`skill-agent-map.json.availableSkills` (72). 44 dirs are in the tree but NOT assignable (section 8),
and three assignable names have no dir (`hyperframes`, `hyperframes-cli`, `claude-ads-critic`).

### 2.1 Assistant (mom-and-pop: bookings, quotes, invoices, reviews, follow-ups, simple posts)

Existing specialists (closest, all metadata-only): `spec-customer-service`, `sup-support-responder`,
`spec-hospitality-guest-services`, `spec-legal-client-intake` (consultation scheduling),
`spec-accounts-payable-agent`, `spec-document-generator`, `spec-chief-of-staff`,
`fin-bookkeeper-controller`, `sales-proposal-strategist`, `mkt-content-creator`.
Existing seats: `support` (haiku, reply drafts; `seat-manifest.ts:156-165`), `sales` (follow-up
plans; `:202-212`), `finance` (billing; `:166-181`), `content` (posts; `:146-155`).
Assignable skills: `customer-success`, `customer-escalation`, `email-sequence`, `copywriting`,
`finance-billing-ops`, `reconciliation`, `docx`, `pdf`, `xlsx`, `internal-comms`.
Unassignable but present: `brand-voice`, `content-engine`.

Missing:
- Prompt: no seat or specialist speaks to a trade business (grep `construction|spa|salon|plumb`
  in catalog: 0 specialist ids; `booking`/`appointment` in lib: 0 real hits, section 8).
- Skills: no `quote-estimate`, `invoice-draft`, `booking-confirmation`, `review-response`,
  `local-business-post` skill dirs (ABSENT).
- Tools: booking/calendar ABSENT (the only `calendar` is the social content calendar,
  `apps/web/lib/social/calendar.ts:44`); customer invoicing ABSENT (`invoice` rows in
  `prisma-store-billing.ts:54-90` are the SaaS's own Stripe billing); reviews ABSENT (grep
  `google business|yelp|review request`: 0); customer messaging ABSENT for customers: the
  gateway (`docs/gateway.md:1-45`) is founder-facing with default-deny pairing, and
  `sendDm` throws `unsupportedApi` on every social platform (`live-platform-adapter.ts:177-179`).
- Manifest capabilities the CLI cannot execute for the seats it would ride on: support = `Email`,
  `support:inbound_email`; sales = `Email`, `crm:read`, `crm:update_draft`, `email:draft`; finance =
  `Stripe`, `usage:read`, `billing:read` (all absent from `CAPABILITY_TOOLSETS` `:36-64`).

### 2.2 Social-media manager (plan, draft, schedule, reply, analytics)

Existing specialists: `mkt-social-media-strategist`, `mkt-content-creator`, `mkt-instagram-curator`,
`mkt-linkedin-content-creator`, `mkt-twitter-engager`, `mkt-tiktok-strategist`,
`mkt-carousel-growth-engine`, `mkt-reddit-community-builder`, `paid-social-strategist`,
`paid-creative-strategist`, `design-brand-guardian`. Overrides in the map for these: none except
`mkt-content-creator` (web-artifacts-builder, doc-coauthoring, frontend-slides, visual-explainer);
the rest get the marketing defaults (brand-guidelines, internal-comms, web-artifacts-builder,
verification-before-completion).
Existing seats: `content` (`social_draft`, `brand_voice_check`; `seat-manifest.ts:146-155`) and
`growth` (`social_draft`, `ads_draft`, `analytics_read`; `:130-145`); pack `marketing` and
`growth-engine` (`FleetPacks.ts:27-36`, `:82-87`).
Assignable skills: `content-creation-and-marketing`, `copywriting`, `brand-guidelines`, `ads`
(has `evals/`), `email-sequence`, `positioning-messaging`.
Unassignable but present: `content-engine` (X/LinkedIn/TikTok/YouTube/newsletter systems),
`crosspost` (X/LinkedIn/Threads/Bluesky adaptation), `brand-voice`, `x-api` (posting via X API,
Python samples), `article-writing`.

Web app already has (not reachable from the CLI, section 3): platforms union of nine
(`apps/web/lib/social/types.ts:1-11`); live adapters for six (`live-platform-adapter.ts:54`)
with `publishPost` (`:118-158`: X tweets, Facebook feed, Instagram container/publish incl. REELS,
LinkedIn ugcPosts, TikTok direct post), `reply` (`:160-175`: X, FB/IG comments, YouTube),
`fetchInbox` (`:181`), `fetchAnalytics` (`:205`); calendar with approval gate
(`social/calendar.ts:44-120`); weekly analytics report (`social/analytics.ts:72`); unified inbox
(`social/inbox.ts:29`); OAuth (`platform-oauth.ts`, `platform-oauth-meta.ts`, `platform-connections.ts`);
`social:draft` internal action (`internal-actions.ts:51`, `:243`); the whole content-mission loop
(`agent-mission-*.ts`, `content-mission*.ts`).

Missing:
- Prompt: `mkt-social-media-strategist` has no `specialistPrompt`; the seat prompt for `content`
  is the design/content generalist.
- Skills: `content-engine`, `crosspost`, `brand-voice`, `x-api` are not in `availableSkills`, so
  `assertSkillsInstalled` (`agent-skills.ts:25-30`) would throw if a catalog row named them.
- Tools in the CLI: `X`, `social:draft`, `analytics:read`, `Email`, `email:draft`, `ads:draft`,
  `PostHog` are all `unavailable` on `growth`/`content` (`SLOT_ENVIRONMENTS` `:1995`, `:2003`
  vs `CAPABILITY_TOOLSETS`). No `social` toolset exists in `ToolsetSchema`
  (`config/sections/tools.ts:8-22`). Scheduling exists only as `cron` (prompt-at-time,
  `docs/cron.md:1-25`), not as a post queue.

### 2.3 Creator (clip long-form to shorts, hooks, captions, thumbnails, transcripts, repurposing)

Existing specialists: `mkt-short-video-editing-coach`, `mkt-video-optimization-specialist`
(YouTube chaptering, thumbnail concepts), `mkt-tiktok-strategist`, `mkt-podcast-strategist`,
`design-visual-storyteller`, `design-image-prompt-engineer` (algorithmic-art, canvas-design),
`mkt-content-creator`. Override skills for the two video ones: `slack-gif-creator` only.
Assignable skills: `copywriting`, `content-creation-and-marketing`, `canvas-design`,
`algorithmic-art`, `slack-gif-creator`, `visual-explainer`, `frontend-slides`.
Unassignable but present: `video-editing` (FFmpeg/Remotion/ElevenLabs/fal.ai pipeline, requires
those binaries), `fal-ai-media` (requires a fal.ai MCP server and `FAL_KEY`), `content-engine`,
`article-writing`, `brand-voice`.

Web app already has: image router with OpenAI/OpenRouter FLUX/SDXL/DALL-E chains and R2 storage
(`apps/web/lib/generation/image-router.ts:132-145`); video GENERATION router, submit-then-poll via
n8n (`video-router.ts:1-17`); TTS `audio-router.ts:1-15`; `music-router.ts`; Higgsfield video assets
handed to publishing (`agent-mission-creative-media.ts:11-27`); `open_gen_ai:*` scopes
(`open-generative-ai.ts:1-8`). All generation, none editing.

Missing:
- Transcription: `packages/trent-core/src/voice/index.ts:1-23` is a deliberate stub that always
  throws "voice transcription is not available in this release"; `whisper` grep: 0 outside it.
- Clipping: `ffmpeg` grep across apps and packages: 0. The sandbox (`scripts/sandbox/Dockerfile`)
  is alpine + python3 + nodejs, apk removed, `--network none`; `execute_code` runs only python or
  javascript (`tools/code_execution/schemas.ts:9`). `LocalBackend.ts` exists but the default
  backend is docker (`config/sections/terminal.ts:13`), and nothing installs ffmpeg on the host.
- Vision: `vision_analyze` (`tools/vision/index.ts:42`) answers a question about an image; no
  frame extraction, no thumbnail rendering, no image generation toolset in the CLI.
- Thumbnails: only "thumbnail concepts" text in `mkt-video-optimization-specialist`.

## 3. Tools each agent needs that do not exist

Trent toolsets today (`config/sections/tools.ts:8-22`): file_ops, terminal, web, browser, code,
vision, memory, delegation, cron, skills, plugins, mcp, human; plus always-on todo, clarify and
session_search (`tools/index.ts:307-312`) and tool_search disclosure. Web is `web_search` and
`web_extract` (`tools/web/schemas.ts:42,59`).

| Need | Assistant | Social | Creator | State |
|---|---|---|---|---|
| Post/reply/analytics on X, FB, IG, LinkedIn, TikTok, YouTube | simple posts | core | publish clips | in web app only (`social/live-platform-adapter.ts`); not in `@trent/core` (its `@/lib/` imports list, section 8, has no `social/`, `platform-*`, `generation/`, `marketing/`, `content-mission*`) |
| Threads, Bluesky, Mastodon | - | nice | - | in the union (`social/types.ts:8-10`) but not live (`:54`); Buffer/Hootsuite ABSENT (`Buffer` hits are byte buffers only) |
| Post queue / scheduler | follow-ups | core | - | web: `social/calendar.ts:44` + approvals; CLI: `cron` only |
| Booking / calendar (Google Calendar, Calendly, Square) | core | - | - | ABSENT |
| Quotes / estimates / customer invoices | core | - | - | ABSENT (billing is the SaaS's own Stripe) |
| Review platforms (Google Business, Yelp) | core | reputation | - | ABSENT |
| Customer channels (SMS, WhatsApp to customers, email send) | core | DMs | - | `gateway/platforms/*` are founder-facing; `Email` unavailable in CLI; `sendDm` throws |
| ffmpeg clip/trim/crop/burn captions | - | - | core | ABSENT |
| Transcription (whisper) | - | - | core | stub that throws (`voice/index.ts`) |
| Image generation / thumbnails | - | assets | core | web only (`generation/image-router.ts`); `fal-ai-media` skill needs an MCP server not configured |
| Video generation | - | - | optional | web only (`generation/video-router.ts`, Higgsfield) |
| MCP bridge to any of the above | all | all | all | `mcp` toolset exists (`tools/mcp/`), so a founder-configured MCP server is the one path that needs no new toolset |

## 4. Cheapest honest packaging

Options, by what the code lets each one carry:

| Package | Prompt | Tools | Skills | Budget/model | Runs in CLI | Improve loop | Cost to add |
|---|---|---|---|---|---|---|---|
| Seat | own `specifics` + manifest | mapped toolsets, gates | own list | own cents + tier | yes, scheduled by planner | every session | `AgentRole` union + 25 exhaustive tables + tests asserting 9 (`seat-capabilities.test.ts:27`, `roster.test.ts`) |
| Catalog specialist | none (V3 override only) | none | category defaults + overrides | balanced, base cap | no (never scheduled) | never (no traces) | one row + a map override |
| Fleet pack | none | none | union of members | none | only its seat members | seat members | one `FLEET_PACKS` entry (`FleetPacks.ts:15`) |
| `fleet create` custom | none | file_ops, terminal | [] | dollars | no | no | nothing to change, nothing gained |

Recommendation per agent:

1. Assistant: FLEET PACK `small-business` = `support`, `sales`, `finance`, `content` seats plus
   new skill dirs (`quote-estimate`, `invoice-draft`, `booking-followup`, `review-response`,
   `local-business-post`) added to `availableSkills` and to the four seats' `SLOT_ENVIRONMENTS`
   skill lists. Reason: every deliverable is a document or a draft the seats already produce
   through `file_ops`; every external side effect (send, book, invoice, post) is `unavailable` in
   the CLI today and gated in the app, so a seat would add enforcement it cannot use. Do not
   promise bookings or invoices until a toolset or an MCP server executes them.
2. Social-media manager: FLEET PACK `social` = `content`, `growth`, `analyst` seats plus
   `mkt-social-media-strategist` and `mkt-content-creator`, with `content-engine`, `crosspost`,
   `brand-voice` promoted into `availableSkills` and onto `DESIGN_CONTENT_STUDIO_SKILLS` /
   `GROWTH_MARKETING_SKILLS` (`agent-catalog.ts:1877-1966`). Reason: the app already executes
   publishing through the `content`/`growth` seats' `social:draft` and the calendar approval gate;
   the missing half is the CLI executor, which is a new `social` toolset wrapping
   `live-platform-adapter.ts`, not a new seat. A seat becomes worth it only when that toolset
   exists and the planner needs to route "reply to comments" work somewhere other than `content`.
3. Creator: FLEET PACK `creator` = `content` seat plus `mkt-short-video-editing-coach`,
   `mkt-video-optimization-specialist`, `design-image-prompt-engineer`, with `content-engine`,
   `article-writing`, `brand-voice` made assignable. Ship it as TEXT-ONLY (hooks, captions,
   chapter maps, repurposing plans from a supplied transcript) and say so in the pack description.
   Reason: clipping, transcription and thumbnail rendering have no executor anywhere in the repo;
   a seat or specialist that advertises them would violate the "never claim" stance in
   `agentSystemPrompt` (`agents.ts:93`). The real unlock is a `media` toolset (ffmpeg +
   transcription provider) and an image-generation tool, which is engineering work, not packaging.

## 5. What the improve loop, goldens, curator and brain give for free

Free for a SEAT, and only a seat:
- Sweep scope: `resolveSweepScope` sweeps `CORE_SEATS` every run and a specialist only when
  installed AND at or above 3 traces (`improve/scope.ts:33-45`); in the CLI a specialist never
  gets a trace (`trace-writer.ts:45`, `:105-106`), so only seats are ever swept (test
  `roster.test.ts:26-30`).
- Suite: goldens promoted from failed real runs become fixtures (`golden-suite.ts:1-18`), looked
  up by seat id (`seat-suite.ts:1-18`, `seat-capabilities.ts` `evalSuiteId`); plus any seat skill
  that ships `evals/evals.json`, which today is only `ads` and `prospecting` (section 8), and the
  wrapper's mechanical overlays. A seat with neither is refused with a reason naming it.
- Prompt evolution: GEPA reflection on the seat's real prompt, human-promoted, rollback on holdout
  regression (`docs/improve.md`, seven gates). Off unless `--live`.
- Brain: `brain/seats/<seat>/notes.md` private notes, `system/` loaded every prompt, ADRs
  (`docs/brain.md:44-56`); memory tiers and per-seat prelude (`fleet-memory/`).
- Curator: lifecycle aging, ledger, rollback and scan gate for agent-authored skills
  (`curator/index.ts:1-5`), which any seat can write through `skill_manage`.

Must be authored per agent: the prompt (`agents.ts` specifics or a `specialistPrompt`), the skill
dirs and their `evals/evals.json` (the only non-golden suite source), a mechanical overlay if
wanted, the `availableSkills` entry, and the manifest row. Goldens cannot be authored by hand
(plan decision 4, `golden-suite.ts:2-4`): they accumulate only from real failed runs, so a new
agent starts with an empty suite and is refused by the gate until it has failed and been reviewed.

## 6. Gap table per agent, ranked by effort (S < M < L < XL)

### Assistant
| # | Gap | Effort | File to touch |
|---|---|---|---|
| 1 | No pack | S | `packages/trent-core/src/fleet/FleetPacks.ts:15` add `small-business`; `FleetPacks.test.ts` |
| 2 | No small-business skills | M | new dirs under `apps/web/.agents/skills/`; `apps/web/lib/data/skill-agent-map.json` `availableSkills`; `agent-catalog.ts:1877-1966` seat skill lists |
| 3 | No trade-business voice in support/sales prompts | S | `apps/web/lib/agents.ts:104` specifics, or a V3 override at `agent-catalog.ts:2068` |
| 4 | `Email`, `support:inbound_email`, `crm:*` unavailable in CLI | L | new `CAPABILITY_TOOLSETS` rows need an executor first: `seat-capabilities.ts:36`; or founder MCP via `tools/mcp/` |
| 5 | Booking, quotes, invoices, reviews have no executor | XL | new toolset under `packages/trent-core/src/tools/`, `config/sections/tools.ts:8` enum, `docs/tools.md` |

### Social-media manager
| # | Gap | Effort | File to touch |
|---|---|---|---|
| 1 | `content-engine`, `crosspost`, `brand-voice`, `x-api` not assignable | S | `skill-agent-map.json` `availableSkills` + overrides for `mkt-social-media-strategist`; `agent-skills.test.ts:77` will re-check |
| 2 | No pack | S | `FleetPacks.ts` add `social` |
| 3 | `mkt-social-media-strategist` has no prompt/tools | S | `agent-catalog.ts:2068` V3 override; and fix `seat-prompt.ts:27` to use `getCatalogAgentV3` so the loop sees it |
| 4 | No CLI executor for post/reply/inbox/analytics | L | new `social` toolset wrapping `apps/web/lib/social/live-platform-adapter.ts` + `platform-connections.ts`; add to `tools.ts` enum and `CAPABILITY_TOOLSETS` for `X`, `social:draft`, `analytics:read` |
| 5 | No post queue in CLI | M | extend `tools/cron/` or wrap `apps/web/lib/social/calendar.ts:44` |
| 6 | Threads/Bluesky/Mastodon not live | M | `live-platform-adapter.ts:54,67` |

### Creator
| # | Gap | Effort | File to touch |
|---|---|---|---|
| 1 | `content-engine`, `article-writing`, `brand-voice` not assignable; video specialists carry only `slack-gif-creator` | S | `skill-agent-map.json` overrides for `mkt-short-video-editing-coach`, `mkt-video-optimization-specialist` |
| 2 | No pack; no honest "text-only" description | S | `FleetPacks.ts` add `creator` |
| 3 | No transcription | L | `packages/trent-core/src/voice/index.ts` (replace the throw with a provider call); `voice.test.ts` |
| 4 | No ffmpeg in sandbox or toolset | XL | `scripts/sandbox/Dockerfile` (adds a binary to an image built to be inert) or a new `media` toolset with a host-ffmpeg backend; `config/sections/tools.ts` |
| 5 | No image generation in CLI | L | wrap `apps/web/lib/generation/image-router.ts` as a toolset, or document `fal-ai-media` MCP setup |
| 6 | `video-editing` / `fal-ai-media` skills assume binaries and MCP servers that are not present | S | skill frontmatter: state the prerequisite and refuse honestly |

## 7. Side findings worth a separate fix

- `AgentInstaller.fromCatalog` reads `found.designedTools` from `AGENT_CATALOG`, where it is
  never set; the three V3 specialists install with `tools: []` (`AgentInstaller.ts:274`).
- `improve/seat-prompt.ts:27` uses `getCatalogAgent`, not `getCatalogAgentV3`, so no specialist
  prompt ever reaches GEPA.
- `fleet create` writes `budget_cap_per_run` (dollars) without the canonical
  `budget_cap_per_run_cents` (`fleet.ts:254`; contrast `AgentInstaller.ts:31-34`).
- `availableSkills` (72) and the bundled tree (113) disagree in both directions (section 8).

## 8. Searches run (evidence for ABSENT)

- `grep -rn ffmpeg apps packages --include=*.ts,*.tsx,*.json`: 0 hits.
- `grep -rni "whisper|transcription|transcribe" apps/web/lib apps/web/app packages/trent-core/src`:
  only `agent-catalog.ts` (specialty text), `voice/index.ts`, `voice.test.ts`.
- `grep -rli booking apps/web/lib packages/trent-core/src`: `workbench-templates.ts:113` (a regex
  word), `artifacts.ts:307` (prose), `plug/schema-v2.ts:7` (a comment). `appointment`: 0.
- `grep -rli invoice`: SaaS billing only (`prisma-store-billing.ts`, `mem-store-billing.ts`, seat
  manifest text). `quote`: string-quoting code only.
- `grep -rli "calendar"`: `social/calendar.ts` (content calendar) and prose.
- Platform greps: LinkedIn/Instagram/TikTok/YouTube/Facebook/Meta hit `platform-oauth*.ts`,
  `platform-connections.ts`, `social/live-platform-adapter.ts`, mission tests. `Buffer`: byte
  buffers only. `Bluesky`, `Mastodon`: `social/types.ts` only. `Threads`: types + email gateway.
- `@/lib/` imports inside `packages/trent-core/src` (sorted unique): active-documents,
  agent-catalog, agent-marketplace, agent-skill-instructions, agents, ai-client,
  capability-memory, eval-harness, eval-mock-providers, gepa, job-events, mcp-connector-catalog,
  memory-tiers, model-gateway, model-policy, orchestration-eval, orchestration-golden-capture,
  orchestrator*, queue, readiness-controls, runtime-eval-overrides, seat-manifest,
  seat-memory-registries, self-improvement/company-playbook-log, semantic-router, skill-foundry,
  skill-health, store, tool-health, tools, trace-store, trench-wiki, types, web-reader-adapter,
  web-search-adapter. No `social/`, `generation/`, `marketing/`, `platform-*`, `content-mission*`.
- `config.fleet` / `.fleet.` in `orchestrator/`, `runtime/`, `agent-runner/`, `apps/cli/src/runtime`:
  0 hits. `active_agents` readers: `doctor/checks/agents.ts`, `setup/`, `ui/banner.ts`,
  `repl/improve-loop.ts` only.
- Skill dirs with `evals/`: `ads`, `prospecting`.
- In tree, not in `availableSkills` (44): agent-introspection-debugging, agent-sort, api-design,
  article-writing, backend-patterns, brand-voice, bun-runtime, coding-standards, content-engine,
  crosspost, deep-research, defuddle, dmux-workflows, documentation-lookup, e2e-testing,
  eval-harness, everything-claude-code, exa-search, fal-ai-media, find-skills, frontend-patterns,
  investor-materials, investor-outreach, json-canvas, market-research, mcp-server-patterns,
  mle-workflow, nextjs-turbopack, obsidian-bases, obsidian-cli, obsidian-markdown,
  product-capability, qmd, security-review, source-command-* (5), strategic-compact, tdd-workflow,
  verification-loop, video-editing, x-api.
- Exhaustive `Record<AgentRole,` outside tests: 25 files/lines (e.g. `seat-manifest.ts:109`,
  `agent-catalog.ts:1782,1977`, `seat-output-schemas.ts:12`, `agent-mission-contracts.ts:60,142`,
  `agents.ts:104`, `ai.ts:107`, `utils.ts:42`, `agent-mission-runtime.ts:352,499`, `app-solo.ts:75`).
- Catalog array body (`agent-catalog.ts:60-1714`) field counts: `skills:` 0, `designedTools:` 0,
  `specialistPrompt:` 0, `evalSuite:` 0, `modelPolicy:` 0.
