# P2-F market packs call their toolsets (2026-09-25)

Wave P2 agent F (Opus, no subagents, no commits). Scope from the lead: `fleet/FleetPacks.ts`,
`fleet/pack-personas.ts`, their tests, a new `fleet/pack-skills.test.ts`, the core skill source
`packages/trent-core/skills/**`, docs/fleet.md (packs section), docs/skills.md if it describes the
core source, and this log. Not touched: `tools/**`, `gateway/**`, `model-gateway/**`, `connect/**`,
`cron/**`, `profile/**`, `config/**`, README.md, apps/web. Defect: scorecard 2026-09-25 retraction 4
and "Not Hermes gaps" first bullet (`02_plan/output/hermes-parity-scorecard-2026-09-25.md`).

## Discovery (before any code)
- The three market packs (`small-business` "Counter Crew", `social` "Signal Crew", `creator`
  "Cutting Room") have no `toolsets` field; `state` for small-business and social says the toolsets
  have not landed (`FleetPacks.ts:158,168`), as do `pack-personas.ts:25,38` and `docs/fleet.md:241-242`.
- The nine business and social skills name 0 business or social tools; every "Approval" section says
  "when the toolset lands". The five creator skills call the media tools already (SkillProvisioner.test
  pins that); `hook-lab` calls `media_thumbnail` before `media_clip`, the reverse of docs/media.md.
- Tool registries read: `tools/business/schemas.ts` (14 tools, `BUSINESS_TOOL_SCHEMAS`),
  `tools/social/schemas.ts` (6, `SOCIAL_TOOL_SCHEMAS`), `tools/media/schemas.ts` (6, `MEDIA_TOOL_SCHEMAS`).
  Invocation form is `<tool> {json}` (`tools/action.ts` parseAction).
- Seats (`trent fleet show <seat>`, exit 0 each): support, sales, finance carry `business` and deny
  `social`; content and growth carry `social` and deny `business`; analyst DENIES `social`; finance
  also denies `file_ops`; `media` is on every seat's floor. So in the social pack only content and
  growth can make a social call, and in the small-business pack only content can post.
- `tools/tool-names.ts` `BUILTIN_TOOLS_BY_TOOLSET` has no `social` entry (not mine to fix; reported).
- Pinned elsewhere (not mine to edit): `apps/cli/.../fleet.test.ts` wants the business state to contain
  "Nothing is sent, booked, invoiced or posted" and the human listing to contain "Drafts only";
  `FleetManager.test.ts` wants quote-estimate's description to contain "Turn a site visit".

## Plan
1. Red first: `fleet/pack-skills.test.ts` (static): mentions resolve to the pack's toolsets, every
   declared toolset is called, argument keys and required keys match the schemas, the seat named in
   "Who runs it" carries the toolset, writes say approval, SMS says outbound, media calls in order.
2. `toolsets` on `FleetPack`: small-business business+social, social social, creator media.
3. Rewrite the nine skills (<= ~60 lines each), fix hook-lab's order, state lines, personas, docs.

## Red first (17:37)
`npx vitest run packages/trent-core/src/fleet/pack-skills.test.ts` -> exit 1, 6 failed, 2 passed (the
parser self-test and the vacuous "no invented tool"). The line that names the defect:
`AssertionError: small-business skills call no business tool (customer_search, stripe_invoice_create, ...): expected false to be true`.
Also red: `small-business declares no toolsets: expected undefined`; nine "makes no <tool> {json} call";
19 missing "Who runs it" seats; four skills say a toolset has not landed; hook-lab media order [0,1,4,3].

## Green (17:55)
- `FleetPacks.ts`: `toolsets` on `FleetPack` (groupings `[]`; small-business business+social; social
  social; creator media); state lines rewritten to the truth (providers, per-call approval, Bluesky and
  Buffer live, Meta/YouTube/GBP "when connected"/review-gated, analyst seat has no social toolset). The
  CLI test's pinned substrings ("Nothing is sent, booked, invoiced or posted", "Drafts only") stay true.
- `pack-personas.ts`: Counter Crew and Signal Crew name the calls their seats make and the approval;
  1751 and 1724 chars (limit 1800). Creator persona unchanged.
- Nine skills rewritten (62-65 lines incl. frontmatter), version 2.0.0; creator skills get a
  "Who runs it" line (1.1.0) and hook-lab now cuts before it pulls the first frame (media.md order).
- Facts found while writing: business `amount_cents` must be > 0 and `quantity` a whole number
  (`money.ts`), so a deposit cannot be a negative line: invoice-draft bills the balance as one line and
  keeps the detail in the file; `stripe_quote_create` has no tax argument, so tax is its own line;
  Stripe does not email a quote (the tool says "Download or email its PDF from the Stripe dashboard");
  SMS is outbound only, so texts give a phone number or link instead of "Reply Y".
- Parser bug caught on the way: a fence indented under a list item was read as one inline span;
  the fence regex now allows indentation.
- Mutation check (then restored from scratchpad copies): a float `amount_cents`, an undeclared
  `tax_rate`, an invented `social_comment_hide` and an Instagram inbox example each fail the test by name.
- `npx vitest run packages/trent-core/src/fleet/pack-skills.test.ts` -> 9 passed, exit 0.

## Docs (18:10)
- docs/fleet.md: packs table gains a Toolsets column and truthful states; persona and skill-source
  paragraphs say what the skills call and what the static test checks. Also corrected the stale
  "Toolsets, from the manifest" table two sections up, which still listed `Stripe`, `X`,
  `social:draft`, `crm:*`, `billing:read`, `support:inbound_email` as unavailable and named five gated
  toolsets (seat-capabilities.ts maps them to business/social; seven are gated; media is on the floor).
  The file was 538 lines at HEAD (over the 500 rule already); it is 538 after, not grown.
- docs/skills.md only points at the core source; nothing to change.

## Verification (final)
- `npx vitest run packages/trent-core/src/fleet packages/trent-core/src/skills packages/trent-core/src/tools/tools-index.test.ts apps/cli/src/commands/__tests__/docs-truth.test.ts packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 0 at 17:58 (56 files, 443 tests). Re-run at 18:08 -> exit 1, one failure in docs-truth
  "states the command counts the registry actually has": README says 34/146, the registry now has
  35/151 because another agent's uncommitted `service` command landed in `apps/cli/src/commands/index.ts`
  meanwhile. README.md is not in this scope; none of my files feed that count.
- `npx vitest run apps/cli/src/commands/__tests__/fleet.test.ts packages/trent-core/src/fleet/FleetManager.test.ts` -> exit 0 (31 tests).
- `cd packages/trent-core && npm run build` -> exit 0. `node scripts/ci/repo-scan.mjs` -> exit 0.
- `npx tsx apps/cli/src/index.ts fleet packs` -> exit 0; `fleet show content` -> exit 0;
  `fleet install small-business --dry-run` -> exit 0.

## Open, not mine
- `tools/tool-names.ts` `BUILTIN_TOOLS_BY_TOOLSET` has no `social` entry, so a plugin manifest could
  claim `social_post` (the reservation list is what `plugins` refuses against).
- Media on posts: Bluesky attaches no image and Buffer refuses `media_url`; the skills say "owner posts"
  for those versions (scorecard "Nothing Trent makes can be posted with media").
