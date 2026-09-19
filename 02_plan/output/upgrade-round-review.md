# Independent review: upgrade-round-design.md (2026-09-19)

Reviewer: Fable, adversarial, read-only. Rulebook principle 8: no creator grades its own work.
Read in order: `AGENTS.md`, `CONTEXT.md`, the design, RA, RB, RC, RD. Code was opened wherever a
premise depends on it; every finding below carries a `file:line` or an input section. No model
was called. Nothing was executed.

Verdict up front: **REJECT as submitted; return for revision before Bobby's gate.** The decision
skeleton (packs over seats now, borrow resume, wrap the app rather than rewrite it, no LangGraph)
survives. Three load-bearing claims do not: the safety sentence in section 2 is false against the
governance code; the portability mechanism in section 3 ("one tool per seat reusing the A2A
runner") does not exist in the runner; and the first executor set in section 2 cannot run at all
because no wave contains the credential flow it depends on. A gate built on those three would ask
Bobby to decide on false premises. Ranked changes are in section 9.

## 1. Premises checked against code and inputs

| # | Design claim (line) | Verdict | Evidence |
|---|---|---|---|
| P1 | "live social adapters for six platforms ... (post, reply, inbox, insights, schedule)" (16-17, 52-53) | Partly false | YouTube has no `publishPost` (`apps/web/lib/social/live-platform-adapter.ts:72` `posts` absent; `:118-157` no youtube branch). TikTok has no reply or inbox (`:71`). TikTok publish is hard-coded `privacy_level: "SELF_ONLY"` (`:152`), so nothing the CLI posts to TikTok is ever public, audit or not, and apps/web is read-only. Instagram and TikTok require a publicly reachable media URL (`:131-137`, `:149-153`), which a clip on a laptop does not have. |
| P2 | "Hermes already speaks A2A to us" (23); C2 "one tool per seat ... reusing the A2A runner" (85-86) | Half false | The runner port is `run({ objective })` and one call is one whole orchestration across all nine seats (`packages/trent-core/src/agent-runner/index.ts:20-30`; `a2a/TaskLifecycle.ts:189-195` ignores the skill id). Nine "seat" MCP tools would all do the same thing. Hermes-to-Trent A2A is documented on both sides (RB 1c, `docs/a2a.md:16-52`) but has never been proven live. |
| P3 | "Every target is an MCP client" (22) | Holds | RB 1a-1d. Caveat the design omits: xAI Remote MCP needs a public Streamable HTTP URL and does not support `require_approval` (RB:137-139), so a run that parks on an approval cannot be relayed there. |
| P4 | index cuts files at 4,000 chars (26) | Holds | `fleet-memory/brain-index.ts:40,97`. |
| P5 | app grounding ranks by hash vectors on a Gemini-only profile (26-27) | Holds | `apps/web/lib/wiki-embeddings.ts:106-107`. |
| P6 | never-claim rule at `agents.ts:93` (20) | Holds | `apps/web/lib/agents.ts:93`. |
| P7 | "packs cost one entry each and inherit the improve loop, goldens, curator and brain for free (RA section 5)" (43-44) | Misleading | RA section 5 says those are free for a SEAT, and only a seat. A pack adds nothing at run time: nothing in `orchestrator/`, `runtime/` or `agent-runner/` reads `config.fleet.active_agents` (RA 1.3, RA section 8); the planner always routes over the same nine roles (`orchestrator/seat-wiring.ts:19`). Skills a pack installs land in the profile-wide store and reach every seat (`tools/skills/index.ts:1-9`), so pack membership scopes nothing. |
| P8 | "each behind an approval floor (money, publishing, customer contact are never auto-approved)" (49-50) | False as mechanism | Floors are shell-command pattern matches (`tools/approval-floors.ts:165-172`; `governance/autonomy-dispatch.ts:89-100` derives `floor` only from command strings). At autonomy `never` an adapter's own `requiresApproval` is ignored (`governance/autonomy.ts:64`). The only default policy rule that forces approval is `money-needs-approval` (`governance/policy-rules.ts`, DEFAULT rules), and it sits under the same autonomy proxy. Nothing today makes a `social_publish` or `twilio_send` JSON call un-auto-approvable. |
| P9 | B4 skills, V3 overrides, `availableSkills` (64-67) | Omits invariant 1 | Every named file is under `apps/web/`: `.agents/skills/` (the only source `SkillProvisioner.ts:46-49` reads), `lib/data/skill-agent-map.json`, `lib/agent-catalog.ts:2068`. `AGENTS.md` invariant 1: read-only, one sanctioned exception per bug. The design does not say how it gets there. |
| P10 | "None of principle 11's six conditions holds" (24) | Holds today; the design's own B3 changes it | RC 2 is right for the CLI as it stands. B3 "Twilio SMS and voice" for "answer inbound SMS and missed calls" (RD 1.1 row 1) needs a public webhook endpoint, which is "low-latency external service coordination". No CLI surface receives webhooks: the gateway is founder-facing (`docs/gateway.md:1-20`), `hooks` are user hooks. |
| P11 | Cost figures (75-77) | Hold | Match RD 1.1, 2.3, 3.2. Missing: 10DLC brand $46 and vetting $15 (RD 4, unverified) and the registration wait, which the design's "week one" silently absorbs. |
| P12 | "Grok Bot has no file surface" (23) | Holds | RB 1d. |
| P13 | `seat-prompt.ts:27` non-V3 lookup (67) | Holds | `improve/seat-prompt.ts:27`. |
| P14 | "existing Gemini embedder" (120) | Holds | `fleet-memory/embedder.ts:70-84`; needs `GEMINI_API_KEY` in the profile. |

## 2. Decision A: packs over seats

What Bobby types and sees under A3, from the code: `trent fleet install small-business --pack`
prints `installed support, sales, finance, content` (`apps/cli/src/commands/groups/fleet.ts:142-152`).
`trent fleet list` shows the same nine seats and 164 specialists it showed before. There is no
`fleet packs` command; the pack description is rendered nowhere except inside the not-found error
(`fleet/FleetManager.ts:149`), so the sentence "the pack description states exactly what executes"
(39-40) describes text no user ever reads. `trent run "book Mrs Lee for a facial Tuesday"` then
plans over the same nine roles. The owner who asked for three named agents gets no new agent, no
new name, no new prompt in the run (prompts are the seat prompt plus a specialist prompt the
planner never selects, RA 1.1), and until a toolset lands, no new action.

That is still the right call for wave 1 (A1 costs 25 exhaustive tables for capabilities that do not
execute yet, RA 1.2), but the design must say the plain thing: A3 delivers skills and, later,
toolsets; it delivers no agent the user can see. To make a pack user-visible without a seat, the
one channel the run does read every prompt is `brain/system/` (RA section 5, `docs/brain.md`):
a pack should install (i) its toolset enablement, (ii) a persona block under `brain/system/<pack>.md`
that names the business type and what the fleet may and may not do, and (iii) a `fleet packs`
listing that renders descriptions. Without (ii) there is nothing "spa" about the spa agent.

## 3. Decision B: the week-one executors

Order. For "an agent a spa owner can use this month" the ranking by review and cost (RD 1.3, 2.4)
is not the order the design gives:
- Needs no review and no registration: Stripe invoices, quotes, payment links; Square bookings
  and invoices over OAuth; Google Calendar (RD 1.1 rows 2-5). These are the assistant's core.
- Needs registration with fees and a wait: Twilio 10DLC (RD 4). Outbound follow-up only; inbound
  SMS and voice need a public endpoint the CLI does not have (P10).
- Needs review or a paid aggregator for every platform a spa is actually on: IG and FB (Meta App
  Review or Buffer), TikTok (audit, and SELF_ONLY in our adapter regardless), YouTube (no publish
  in our adapter). Bluesky is free because nobody's customers are there.
So B3-core (Stripe, Calendar or Square) is first, B2 media is second because it needs no external
account at all, and B1 social is last. The design puts B1 first and B3 in wave 2.

Feasibility of wrapping the app's social adapters from the CLI under invariant 1. The adapter is
injectable: `createLiveSocialAdapter(platform, { tokenResolver, httpFetch })`
(`live-platform-adapter.ts:43-52, 84-87`), so the CLI can supply tokens without touching the app
store. But the default resolver reads `store.getIntegration` and `decryptJson`
(`:240-246`), and that row is written only by the web OAuth routes (`apps/web/lib/platform-oauth*.ts`,
`platform-connections.ts:47-79`) using `META_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET`,
`GOOGLE_CLIENT_ID/SECRET`. The CLI has no OAuth flow, no token store, and under Node the app store
is `EphemeralStore` (AGENTS.md defect 9; `apps/cli/src/runtime/headless.ts:201`). Every executor in
B1 and B3 (Meta, Google, Square, Stripe Connect if used) needs a `trent connect <provider>` loopback
OAuth flow writing to the profile secrets, and a `tokenResolver` fed from it. No wave contains it.
This is the single largest omission: without it B1 and B3 execute nothing.

The calendar is a worse wrap than the adapter: `createSocialCalendarPosts` needs the app's
`SocialPost`, `SocialAccount` and `Approval` store shapes (`calendar.ts:7-15, 44-91`) and
`assertPublishingAllowed` requires `account.autoPublishEnabled` set from the web UI (`:130`). The
CLI already has its own approval rows and a job file (`docs/cron.md:12-16`); the post queue should
be built there, and it is the social manager's job number one (RD 2.3 row 1), not a wave-3 item.
Buffer needs the founder to connect channels in Buffer's own UI first; the design should say so.

B2.a. The sandbox image is designed to hold no packages: no pip, no npm, apk removed
(`scripts/sandbox/Dockerfile:7-8, 16-18`). Option (i) is not "grow the image", it is a different
image contract (packages installed at build time, pinned, no network at run time). Recommend (ii)
host backend first, `execFile` with argument arrays (rulebook coding rule 7), a binary allowlist,
and the doctor naming what is installed; add (i) only when a founder asks for isolation.

## 4. Decision C: portability

"Droppable into Claude Code, Codex, Hermes and Grok" in the owner's words is a file: Claude and
Grok read `.claude/agents/<name>.md` (RB 1a, 1d), Codex `.codex/agents/*.toml` (RB 1b), Hermes a
profile distribution (RB 1c). C2 gives none of those; it gives the host one MCP tool and requires
a running Trent. And the per-seat shape C2 promises is not available (P2): the runner runs the
whole fleet, so "one tool per seat" would be nine names for one behaviour, which is the kind of
advertised-but-not-real surface invariant 2 exists to stop.

What is lost each way (RB 3, 4): a file loses budget, floors, evals, pins and brain at the host
and the prompt freezes at export; a remote call loses roster membership, offline use and the host's
own tools. The loss that matters more for this owner is the file, because the request was to drop
the agent in, and because RA's objection to a file ("a prompt-only agent violates never-claim")
dissolves once the exported file's `mcp.json` points the host at Trent's toolsets: the host agent
then has real executors with Trent's floors behind them. That reframes C2 usefully: `trent mcp
serve` should expose Trent TOOLSETS (social, media, business, memory) as MCP tools, with approval
returned as a `needs_approval` result plus an approval id the founder settles in `trent approvals`,
and expose seats only when a seat-targeted runner exists. Then C3's Claude renderer (Grok reads it)
plus that MCP server is the deliverable, in wave 1, and the Hermes and Codex renderers follow.

## 5. Decisions D and E

D2 is justified: RC 2 walks all six principle-11 conditions and none holds for the CLI; the
LangGraph resume-re-executes-the-node objection is real against a seat loop we cannot edit
(`RC:226-229`); the hydrate and select-ready exports exist (`apps/web/lib/orchestrator-run-persist.ts:14`,
`orchestrator.ts:80`). One condition on D2 the design misses: resume re-enqueues ready steps, and
a side-effecting call is replayed from the idempotency store only if its tool name carries one of
`write patch execute exec send network terminal process_manage delegate cronjob_manage`
(`governance/idempotent-dispatch.ts:23`). `publish`, `post`, `reply`, `book`, `invoice`, `charge`
are classified by policy (`policy-rules.ts:109, 113`) but not recorded for idempotency. D2 plus B1
without that fix is a double post or a double invoice after a crash.

E3 is scope creep for this round. The question the owner asked is "RAG?" inside "surgical". What
changes what a founder can do: E1 (import Markdown, text, CSV with chunk-id citations) and the
PDF/DOCX/XLSX extractors (the folder RC 1.6 was asked about). The golden gate is cheap and must
precede any ranker change (RC item 3). The local ONNX reranker and contextual prefixes are quality
items with no new capability; adopt them only when the golden set shows recall@8 below a stated
number. The half-day wiki-grounding honesty item (RC item 7) belongs in the minimal set. So: E1 +
extractors + golden gate + doctor honesty, about six days, and the reranker and prefixes deferred
with the number that would trigger them. One shape issue: the ledger row is
`{surface, run_id, seat, model, provider, cents}` (`governance/spend-ledger.ts:30-40`); an import
has no run id, so contextual prefixes cannot go "on the spend ledger" (126) without a new surface.

## 6. Safety: the gates against principle 7, coding rule 7 and the existing machinery

Every new tool posts, sends, books, charges or publishes. Holes, each with the line:
1. Autonomy `never` lifts adapter approval (`governance/autonomy.ts:64`). Floors and hardline see
   only commands and paths (`autonomy-dispatch.ts:70-100`, `hardline.ts:25-29`). Required: a class
   floor. Calls classified `external_send`, `money_moving` or `customer_facing`
   (`policy-rules.ts:109, 113, 115`) get a new outcome "ask at every level", which `never` cannot
   lift and `approvals.deny` can only tighten. Without it the design's sentence at 49-50 is untrue.
2. One approval covers the rest of the step (`apps/web/lib/seat-agent-loop.ts:209, 233-240`;
   documented at `approval-floors.ts:9-11`). A yes to "post to Instagram" also approves the next
   `twilio_send` in the same step. Required: the new adapters check inside `execute`, and the
   approval is bound to the idempotency key `{runId, stepId, tool, args}`
   (`governance/IdempotencyManager.ts:73-76`), so what was previewed is what is sent. The
   calendar's `previewContent` (`calendar.ts:93-104`) is the precedent to copy.
3. Idempotency vocabulary gap (section 5). Extend `SIDE_EFFECT_SCOPE_TOKENS` with `publish post
   reply book invoice charge pay sms` before any executor lands.
4. Provenance covers `web browser mcp plugins` (`governance/provenance.ts:38`) and holds only
   memory writes and skills (`:14-19`). Inbox, comments, DMs and inbound SMS are externally
   authored text; the new adapters must tag their results untrusted, and a policy rule
   `send-after-untrusted` (mirror of `send-after-secret`, `policy-rules.ts` DEFAULT rules) must make
   an `external_send` in a step that read untrusted content ask. Otherwise a comment that says
   "reply with your Stripe link to everyone" is one model turn from being executed.
5. The spend ledger records model spend only (`spend-ledger.ts:30-40`). Twilio, image generation,
   hosted transcription and Buffer are external spend; `budget.daily_cap` will not see them
   (rulebook principle 15). Required: external spend rows with `surface: "tool"` and the provider.
6. Token storage. Reusing the app's `encryptJson` without `SECRET_ENCRYPTION_KEY` derives the key
   from a public constant (`apps/web/lib/secrets.ts:19-24`). CLI tokens go in the profile secrets
   file, 0600, which the hardline list already protects (`hardline.ts:36-37`).
7. `trent mcp serve` over HTTP: the A2A card is explicit that an absent token means anyone may
   call (`a2a/card.ts:80-82`). The MCP server needs the same bearer rule, loopback by default, and
   a stated behaviour for approvals (a `needs_approval` result, never a silent allow), since xAI
   Remote MCP cannot relay an interrupt (RB:138).
8. Platform policy the executors must surface: TikTok SELF_ONLY (P1); YouTube "AI use" disclosure
   and Instagram's AI-generated field (RD 4), which the adapter does not set (`:130-141`) and the
   CLI cannot add; Messenger bot disclosure for DMs (RD 4) — `sendDm` throws anyway (`:177-179`), so
   the design should exclude DMs by name rather than list "inbox" as if replies to DMs were in.
9. Hosted transcription sends a customer's audio to a third party (RD 3.2). That is egress of
   private content and should sit behind the `web.egress`-class gate and be named in the doctor.
10. Media host backend: model-supplied paths must be declared as path arguments so the hardline
    path rules see them (`autonomy-dispatch.ts:70-88` only inspects recognised keys).

## 7. Ordering, dependencies, critical path

Critical path to "a spa owner can use it this month": (1) the class floor, per-call approval
binding and idempotency tokens (section 6, items 1-3), because no executor may ship before them;
(2) `trent connect <provider>` OAuth and token store; (3) B3-core Stripe invoices and payment
links, Google Calendar or Square bookings; (4) spa and trades skills and a `brain/system/` persona
block; (5) `fleet packs` listing with honest descriptions. Everything else is off that path.

Wave 1 as written has six parallel items and hidden dependencies: the retrieval golden gate needs
E1's chunk ids (RC item 3 fixtures), so it is sequential to E1, not parallel; B4 writes into
apps/web (P9) and needs the invariant-1 decision first; `trent mcp serve` "reusing the A2A runner"
needs the runner question (P2) settled first. Wave 2 puts B3 after B1, inverting the owner's value
order. Wave 3 holds the post queue, which is the social manager's first job.

Gold-plating for this round: the ONNX reranker and contextual prefixes (E2/E3 tail), Bluesky for
businesses whose customers are on Instagram, nine per-seat MCP tools, the A2A card retag, the
Hermes and Codex renderers before one host has been proven, and "both" media backends.

## 8. What the evidence requires that the design omits

1. A CLI OAuth and token flow for Meta, Google, Square and TikTok, feeding `tokenResolver`
   (`live-platform-adapter.ts:43-52, 84-88, 240-246`; `apps/web/lib/platform-oauth.ts` is web-only).
2. A class-based approval floor that autonomy `never` cannot lift (`governance/autonomy.ts:64`).
3. Per-call approval binding inside the new adapters (`apps/web/lib/seat-agent-loop.ts:209`).
4. Idempotency tokens for publish, post, reply, book, invoice, charge
   (`governance/idempotent-dispatch.ts:23`).
5. The full registration checklist for a new toolset: `config/sections/tools.ts:8-22`,
   `tools/index.ts:222` `IMPLEMENTED_TOOLSETS`, `tools/index.ts:405-421` `TOOLSET_BY_ADAPTER` (an
   adapter absent from it reaches EVERY seat, `:416-421`), `tools/tool-names.ts:9`,
   `fleet/seat-capabilities.ts:36-71`, `orchestrator/seat-wiring.ts:22-26` gates. The design names
   two of seven.
6. How B4 gets into `apps/web/.agents/skills/`, `skill-agent-map.json` and `agent-catalog.ts:2068`
   under invariant 1; or a second skill source under `packages/trent-core/` for
   `fleet/SkillProvisioner.ts:46-49`.
7. A `fleet packs` command; today descriptions render only in an error (`fleet/FleetManager.ts:149`).
8. The sandbox image's no-packages contract (`scripts/sandbox/Dockerfile:7-8, 16-18`) versus B2.a (i).
9. The adapter's real platform matrix: no YouTube publish, no TikTok reply or inbox, TikTok
   SELF_ONLY, IG and TikTok need hosted media (`live-platform-adapter.ts:71-72, 131-137, 149-153`).
10. External spend on the ledger (`governance/spend-ledger.ts:30-40`) and untrusted tagging of
    inbox and SMS results (`governance/provenance.ts:38`).

## 9. Verdict and required changes, ranked

**REJECT as submitted.** Revise and resubmit before the gate. The skeleton A3, D2, wrap-not-rewrite
and no-LangGraph stands. Required, in order:

1. Rewrite section 2's safety sentence to the mechanism: add the class floor, per-call approval
   binding and idempotency tokens as wave-1 items that block every executor (section 6, 1-3).
2. Add `trent connect <provider>` (loopback OAuth, profile-secrets token store, `tokenResolver`)
   to wave 1 as a prerequisite of B1 and B3; name the env each provider needs and who owns the
   developer apps (section 3).
3. Reorder B: B3-core (Stripe, Calendar or Square) first, B2 media second, B1 social last; drop
   inbound SMS and voice from this round or add the webhook surface as a named decision; move
   the post queue into B1 on the CLI's own job file and approval rows.
4. Rewrite C: `trent mcp serve` exposes toolsets, not nine seat tools; C3's Claude renderer with
   `mcp.json` pointing at that server moves to wave 1; per-seat tools wait for a seat-targeted
   runner; state the HTTP bearer and the approval-as-result behaviour.
5. Rewrite A honestly: "no new agent is visible until toolsets land"; add the `brain/system/`
   persona block and a `fleet packs` listing to A3; keep A1 as the revisit trigger.
6. Cut E to E1 + extractors + golden gate + doctor honesty; defer reranker and prefixes behind a
   stated recall@8 trigger.
7. Resolve invariant 1 for B4 at the gate: a second skill source in `packages/trent-core/` or a
   declared sanctioned edit per file.
8. Correct the platform matrix (P1) in B1 and the creator pack description; exclude DMs; add the
   AI-disclosure and TikTok-private facts to what the tool tells the user.
9. Choose B2.a (ii) host backend first with `execFile` and an allowlist; state why (i) changes the
   image contract.
10. Put external spend on the ledger and untrusted tags on inbox and SMS results; add the
    `send-after-untrusted` policy rule.
11. Fix wave 1's hidden dependencies (golden gate after E1; B4 after item 7; C2 after item 4) and
    add a live proof of Hermes A2A discovery before any Hermes renderer work.
