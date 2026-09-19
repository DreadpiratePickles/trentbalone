# Upgrade round design: three market agents, portable agents, harness upgrades

Version 2, 2026-09-19, rewritten after the independent review
(`02_plan/output/upgrade-round-review.md`, verdict REJECT as submitted; all eleven required
changes are folded in below and each is marked "(review N)"). For Bobby's gate. Inputs:
`01_discovery/output/{upgrade-agents-audit,portable-agents-research,harness-upgrade-audit,
market-agents-research}-2026-09-19.md`. Binding rulebook principles: 1, 7, 11, 12, 14, 15.

## 0. The honest frame

- The three agents are a tools and safety problem, not a prompts problem. The CLI executes none
  of the side effects they need (post, reply, book, invoice, send), and today's approval machinery
  does not cover them either: floors and the hardline list see only shell commands and paths
  (`tools/approval-floors.ts:165`, `governance/autonomy-dispatch.ts:70-100`), autonomy `never`
  lifts adapter approval (`governance/autonomy.ts:64`), one approval covers the rest of a step
  (`apps/web/lib/seat-agent-loop.ts:209`), and publish, post, reply, book, invoice and charge are
  not idempotency tokens (`governance/idempotent-dispatch.ts:23`). So the first deliverable of
  this round is the gate every executor sits behind (section 1); no executor lands before it.
- No new agent is visible to a user until its toolsets land (review 5). Packs are a grouping and
  a persona, not a runnable thing: pack descriptions render only in an error today
  (`fleet/FleetManager.ts:149`) and packs are never read at run time. The design says so and adds
  a `fleet packs` listing and a persona block so a user can see and pick one.
- "Drop into Claude Code, Codex, Hermes, Grok" means a file the user can copy (review 4). The file
  cannot carry budget, floors, evals, version pins or the brain; it can carry the prompt, the
  skills and an `mcp.json` that points the host at Trent's toolsets, so the host agent gets real
  executors with Trent's gates behind them. That is the deliverable; a running Trent is required
  for the executors, and the file says so.
- The CLI has no OAuth flow or token store (review 2): the app's adapter resolves tokens from a
  web-only integration row (`apps/web/lib/social/live-platform-adapter.ts:240-246`), ephemeral
  under Node. `trent connect <provider>` is a prerequisite of every platform executor.
- The harness needs no new engine (RC section 2; principle 11) and no vector database. It needs
  ingestion and a retrieval number.

## 1. Gate first: the safety mechanism every executor requires (review 1, 10; wave 1 blockers)

G1 Class floor: tool calls classified `external_send`, `money_moving` or `customer_facing`
   (`governance/policy-rules.ts:109-115`) get a new outcome "ask at every level" that autonomy
   `never` cannot lift and `approvals.deny` can only tighten. Test: `autonomy: never` still asks
   before a post, a payment link and an SMS.
G2 Per-call approval binding: the new adapters check approval inside `execute`, and the approval
   is bound to the idempotency key `{runId, stepId, tool, args}` (`governance/IdempotencyManager.ts:73-76`)
   so what was previewed is what is sent; the calendar's `previewContent`
   (`apps/web/lib/social/calendar.ts:93-104`) is the precedent. Test: a yes to "post to
   Instagram" does not approve a following `twilio_send` in the same step.
G3 Idempotency vocabulary: `SIDE_EFFECT_SCOPE_TOKENS` gains publish, post, reply, book, invoice,
   charge, pay, sms, so `orchestrator.resume` (section 5) cannot double-post.
G4 Provenance: inbox, comments, reviews and inbound SMS are externally authored text; the new
   adapters tag their results untrusted (`governance/provenance.ts:38`), and a policy rule
   `send-after-untrusted` (mirror of `send-after-secret`) makes an `external_send` in a step that
   read untrusted content ask. DMs are excluded by name (`sendDm` throws, adapter `:177-179`).
G5 Spend: external spend (Twilio, image generation, hosted transcription, Buffer) goes on the
   ledger as rows with `surface: "tool"` and the provider (`governance/spend-ledger.ts:30-40`).
G6 Tokens: `trent connect <provider>` runs a loopback OAuth flow (or takes an API key) and stores
   tokens in the profile secrets file, 0600, already protected by the hardline list
   (`governance/hardline.ts:36-37`); a `tokenResolver` feeds the app adapter. The app's
   `encryptJson` is not reused (its key derives from a public constant without
   `SECRET_ENCRYPTION_KEY`, `apps/web/lib/secrets.ts:19-24`).
G7 Toolset registration checklist, all seven places, for every new toolset:
   `config/sections/tools.ts:8-22`, `tools/index.ts:222` IMPLEMENTED_TOOLSETS,
   `tools/index.ts:405-421` TOOLSET_BY_ADAPTER (an adapter absent there reaches every seat),
   `tools/tool-names.ts:9`, `fleet/seat-capabilities.ts:36-71`, `orchestrator/seat-wiring.ts:22-26`,
   `docs/tools.md`.
G8 Media host backend: model-supplied paths are declared path arguments so the hardline path rules
   see them (`autonomy-dispatch.ts:70-88`); hosted transcription is egress of private audio and
   sits behind the `web.egress`-class gate, named in the doctor.
G9 `trent mcp serve` over HTTP: bearer required for non-loopback (same rule as the A2A card,
   `a2a/card.ts:80-82`), loopback by default, and an approval is returned as a `needs_approval`
   result with an approval id the founder settles in `trent approvals`, never a silent allow.

## 2. Decision A: packaging (review 5)

Options: A1 new seats (enforcement per agent; costs the `AgentRole` union, 25 exhaustive tables and
tests asserting nine); A2 catalog specialists (no prompt, tools, model or suite; never scheduled;
no traces); A3 fleet packs over existing seats plus new skills, with a persona block in
`brain/system/` per pack and a `trent fleet packs` listing (recommended).

A3 as shipped means: `trent fleet packs` lists small-business, social and creator with a one-line
truthful state each ("drafts only until the business toolset is connected"); `trent fleet install
<pack>` installs its skills and writes the persona block; the planner still routes to the nine
seats. Nothing else is visible until a toolset lands. Revisit A1 when the `social` toolset exists
and the planner needs to route reply work away from `content`.

Invariant 1 (review 7): the pack's skills and prompt overrides do not go into `apps/web/`. A second
skill source under `packages/trent-core/skills/` feeds `fleet/SkillProvisioner.ts:46-49`, and the
prompt overrides live in the pack's persona block, not in `agent-catalog.ts`. The one exception
to request: `seat-prompt.ts:27` is core code, not the app, and is fixed to the V3 lookup.

## 3. Decision B: executors, reordered for a spa owner this month (review 3, 8, 9)

Order by "no platform review, no public webhook, real value week one":
- B3-core `business` toolset: Stripe invoices, quotes and payment links; Google Calendar; Square
  bookings and invoices. None needs app review. Outbound Twilio SMS with 10DLC registration is in;
  INBOUND SMS and voice are out of this round (they need a public webhook surface the CLI lacks,
  which is a principle-11 condition; named as a later decision). Google Business Profile reviews
  wait for Basic Access (Bobby applies day one).
- B2 `media` toolset: host backend first (review 9; `execFile` with an argument array, an
  allowlist of ffmpeg, whisper.cpp or faster-whisper, PySceneDetect, MediaPipe; the doctor names
  what is installed). The sandbox image stays on its no-packages contract
  (`scripts/sandbox/Dockerfile:7-8,16-18`); a docker variant is a later option. Transcription
  replaces the throwing stub (`packages/trent-core/src/voice/index.ts`); image generation through
  the app's image router.
- B1 `social` toolset, last: wraps the app adapter for what it really does (review 8): X, Facebook,
  Instagram, LinkedIn post and reply and insights; YouTube has no publish path; TikTok is
  SELF_ONLY and has no reply or inbox; Instagram and TikTok need hosted media URLs. Bluesky direct
  (no review) and Buffer as the week-one publisher for reviewed platforms. The post queue rides
  the CLI's own job file and approval rows, in B1, not wave 3. The tool tells the user about
  TikTok private-only, the YouTube AI-use disclosure and Instagram's AI-generated field, which
  the adapter does not set. DMs excluded.
- B4 Skills and personas (after section 2's invariant decision): quote-estimate, invoice-draft,
  booking-followup, review-response, local-business-post; content-engine, crosspost, brand-voice,
  x-api made assignable through the core skill source; hooks, captions, chapter maps, repurposing
  plans for the creator. The creator pack ships text-only with an honest description until B2
  lands (Bobby's call, gate question 7).

Costs (RD): Twilio about 0.8 cents per SMS and 1.15 dollars per number per month; Buffer 5 dollars
per channel per month; hosted transcription 0.3 to 0.6 cents per minute; thumbnails 4 to 7 cents;
X API 200 dollars per month, proposed skip.

## 4. Decision C: portability (review 4)

C-final: `trent mcp serve` exposes Trent TOOLSETS (business, media, social, memory, brain) as MCP
tools over stdio and Streamable HTTP with G9's rules, not nine seat tools (the A2A runner runs a
whole orchestration, `agent-runner/index.ts:20-30`; per-seat tools wait for a seat-targeted
runner). The `trent-agent/2` package is an Agent Plugins 1.0.0 directory (`plugin.json` with
`extensions["ai.trent.agent"]`: prompt, model tier, toolsets, denied, approval gates, budget cents,
eval suite id, version hashes, brain files; `skills/`; `mcp.json` pointing at the Trent MCP server;
`brain/`). Renderers: Claude `.claude/agents/<name>.md` plus `.mcp.json` first (Grok Build reads the
same layout), Hermes profile distribution second (toolset names match; a live proof of Hermes A2A
discovery precedes it), Codex `.codex/agents/*.toml` plus `AGENTS.md` third. Importers for the
same three. Also: `agent.json` extended to the full seat record, nested `metadata:` frontmatter
parsed, skill `scripts/` and `tools/` kept on export, the A2A card retagged by toolset.

## 5. Decision D: engine (unchanged)

D2: borrow `orchestrator.resume(runId)` over the app's hydrate and select-ready-steps functions and
one typed resume Command; no LangGraph, no Agents SDK as the core (RC section 2 and 5). Resume
lands only after G3, so a resumed run cannot repeat a side effect.

## 6. Decision E: RAG scope, cut (review 6)

E-final: `trent brain import` for Markdown, text and CSV with heading- and page-aware chunks,
sha256 and provenance front matter, the existing embedder and chunk-id citations into the CONTEXT
tier; PDF, DOCX and XLSX extractors behind the same import; a retrieval golden set with a
deterministic recall@8 gate in the improve loop (lands after ingestion); the doctor names the
app's wiki grounding as hash-ranked or provider-ranked. Deferred behind a stated trigger (recall@8
on the golden set below 0.9 after ingestion of real documents): the local cross-encoder reranker
and contextual chunk prefixes.

## 7. Waves (after the gate; at most six Opus agents, disjoint files, isolate.sh per commit)

Wave 1 (gate and foundations; no external accounts needed): G1-G5 and G7 (one agent, blocks the
rest); G6 `trent connect` with Stripe, Google and Square providers; E ingestion (Markdown, text,
CSV) then the golden gate; D2 resume (after G3); `fleet packs`, persona blocks, the core skill
source and `seat-prompt.ts` fix (A3, B4); `trent mcp serve` over toolsets (C, after G9).
Wave 2: B3-core business toolset (after G1-G3, G6); B2 media host backend and transcription
(after G8); the Claude renderer and `trent-agent/2` manifest (after C); PDF, DOCX, XLSX extractors;
image generation.
Wave 3: B1 social toolset with Bluesky, Buffer and the post queue (after G4, G6 Meta and Buffer
providers); Hermes renderer (after the A2A discovery live proof) and Codex renderer; importers;
Google Business Profile reviews when access is granted; A2A card retag.
Every wave: a live proof on Bobby's key; approval-floor tests for every side-effecting tool.

## 8. Decisions for Bobby at the gate
1. A3 packs with a persona block and `fleet packs` (recommended) versus A1 new seats.
2. Invariant 1 for skills: a second skill source under `packages/trent-core/skills/` (recommended)
   versus sanctioned edits to the app's skill map per file.
3. Executor order B3-core, B2, B1 (recommended) versus social first.
4. Inbound SMS and voice: out of this round (recommended) versus adding a public webhook surface.
5. Media: host backend first with an allowlist (recommended) versus growing the sandbox image.
6. Portability: toolsets over MCP plus the Claude file renderer in wave 1 (recommended).
7. Creator pack text-only first with an honest description (recommended) versus wait for media.
8. RAG: the cut scope E-final (recommended) versus the full E3 now.
9. Which platform applications Bobby submits in week one: Meta App Review, TikTok audit, YouTube
   audit, Google Business Profile Basic Access, Twilio 10DLC; and whether Buffer (5 dollars per
   channel) is acceptable while X (200 dollars per month) is skipped.
