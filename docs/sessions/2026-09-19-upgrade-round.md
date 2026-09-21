# 2026-09-19 — Upgrade round: three market agents, portable agents, harness upgrades

Bobby's ask: (1) three new agents usable in today's climate: an "assistant" for mom-and-pop
businesses (construction, beauty spas and the like), a social-media manager, and a creator agent
for clipping and all content generation; (2) Trent's agents droppable into other harnesses
(Claude Code, Codex, Hermes, Grok bots), not only our own; (3) make our harness better, weighing
LangGraph and RAG. Do it surgically and mindfully: discovery, design with options, Fable review,
Bobby's gate, then waves.

## Steps
- Discovery launched (4 Opus agents, no subagents): RA catalog+manifest audit for the three agents;
  RB portability formats of the four target harnesses; RC harness-upgrade audit (LangGraph, RAG)
  against our orchestrator; RD market needs and the real tool/API landscape for the three agents.

## State at 2026-09-19 (written before a possible usage-limit cut)
- Shippable goal: complete. HEAD 29b80d2 pushed; CI green (run 35423798575 on 8dc9cd9); repo is
  public (history scanned, fixtures only); working tree clean but notes/.
- Upgrade round: discovery only so far, no code changed. Four Opus agents running in the
  background; each writes ONE file under 01_discovery/output/ and commits nothing:
  - RA -> upgrade-agents-audit-2026-09-19.md (what the catalog/manifests/skills/tools already
    give the assistant, social-media and creator agents; gaps; seat vs specialist vs pack)
  - RB -> portable-agents-research-2026-09-19.md (Claude Code / Codex / Hermes / Grok agent
    formats; matrix; three package designs; recommendation)
  - RC -> harness-upgrade-audit-2026-09-19.md (our harness strengths/weaknesses; LangGraph
    options i/ii/iii under rulebook principle 11; RAG ingestion+retrieval+eval design; ranked items)
  - RD -> market-agents-research-2026-09-19.md (jobs to be done, platform APIs and review
    requirements, week-one tool sets, prices, risks)
- If this session is cut: the agents' outputs land in those files (or not, if they were cut too:
  re-run the four briefs, recorded in the chat transcript, one agent per file). Next steps after
  discovery: write `02_plan/output/upgrade-round-design.md` with 2-3 options per major decision
  (agent packaging, portability design, LangGraph adopt/borrow/leave, RAG scope), get an
  independent Fable review, then ask Bobby the decisions one at a time, then waves of <=6 Opus
  agents with disjoint files, committed via scripts/dev/isolate.sh.
- Bobby's constraints for this round: surgical and mindful; a major upgrade; agents must work in
  today's climate (real integrations, approval gates on money, publishing, customer contact);
  agents must be droppable into other harnesses, not only ours.
- Model note: the session switched to Opus 5 at this point (Bobby's /model); reasoning-heavy
  synthesis and the design review should still go to a Fable agent per the standing rule.
- RB landed -> `01_discovery/output/portable-agents-research-2026-09-19.md`. Findings: no target
  harness carries a per-run budget, memory/brain, verifier suites or version pins natively;
  Grok Build reads `.claude/agents/*.md` (one Claude renderer covers two hosts); Grok Bot has no
  file surface (remote-call only); Codex agents are `.codex/agents/*.toml` and Codex dropped its
  MCP-server mode; Hermes imports Claude Code/Codex but not subagent files; Trent has no MCP
  server today and `agent.json` omits gates/budget/tier/eval/brain; our frontmatter parser cannot
  read the nested `metadata:` map. Recommendation: (ii) `trent mcp serve` first (reuse the A2A
  runner), then (iii) a `trent-agent/2` package (Agent Plugins 1.0.0 dir + `extensions["ai.trent.agent"]`,
  skills/, mcp.json, brain/) with per-harness renderers producing (i).
- RD landed -> `01_discovery/output/market-agents-research-2026-09-19.md`. Week-one tool sets:
  assistant = Twilio SMS/voice (10DLC registration, no app review), Google Calendar, Stripe
  invoices/payment links/quotes, Square bookings+invoices; social = drafting + Bluesky direct +
  Buffer API ($5/channel) or Ayrshare as the publisher, Meta App Review submitted in parallel;
  creator = fully local pipeline (faster-whisper/whisper.cpp, PySceneDetect, MediaPipe, ffmpeg)
  at $0/clip, hosted transcription fallback, Gemini/FLUX thumbnails ~$0.05/image, YouTube private
  uploads until the audit. Demand evidence supports approval gates (89% of creators always
  review AI output). Fresha closed; Vagaro/Boulevard gated; X API $200/mo Basic.
- RA landed -> `01_discovery/output/upgrade-agents-audit-2026-09-19.md`. Catalog specialists are
  metadata plus category-default skills (no prompt, tools, model policy or suite); `fleet install`
  writes a record nobody runs; only the nine seats execute; specialists produce no traces so the
  improve loop never sweeps them. Assistant gaps: booking/quotes/invoices/reviews tools absent,
  customer messaging has no executor. Social: the web app already has live adapters for X, FB,
  IG, LinkedIn, TikTok, YouTube plus a calendar with an approval gate, none wrapped into core;
  four social skills unassignable. Creator: ffmpeg absent, sandbox inert, transcription stub
  throws, no media toolset. Recommendation: fleet packs (small-business, social, creator) over
  existing seats plus newly assignable skills, with new `social` and `media` toolsets wrapping
  the app adapters and a local clip pipeline. Side defects: `fromCatalog` reads unset
  `designedTools`; `seat-prompt.ts:27` non-V3 lookup; `fleet create` omits the budget cap.
- RC (harness upgrade audit) was cut by the weekly usage limit before writing; resumed.
- RC landed -> `01_discovery/output/harness-upgrade-audit-2026-09-19.md`. LangGraph: do not adopt
  (none of principle 11's escalation conditions holds; resume-re-executes-the-node would demand
  idempotency in the app's seat loop we cannot edit and create a second run truth); borrow two
  patterns: `orchestrator.resume(runId)` over the app's hydrate + select-ready-steps, and one
  typed resume Command. RAG: no ingestion exists today (brain CLI is status/log/show; the index
  covers three dirs and cuts at 4,000 chars; file_ops reads binaries as UTF-8); build `trent brain
  import` (files-are-truth Markdown under brain/docs with sha256/page/provenance front matter,
  heading- and page-aware chunks, contextual prefixes, the existing Gemini embedder), hybrid +
  a local ONNX cross-encoder rerank, chunk-id citations into the CONTEXT tier, and a recall@8
  golden gate in the improve loop. Correction to the roadmap: the app's planner/seat grounding
  path DOES use wiki-embeddings.ts (hash vectors on a Gemini-only profile), so the wrapper drains
  a pipeline ranked by hash vectors today.
- Discovery complete (4 files). Next: design doc with options -> Fable review -> Bobby's gate.
- Wrote `02_plan/output/upgrade-round-design.md` (decisions A-E with options and recommendations,
  waves, seven gate questions). Sent for an independent Fable review before Bobby's gate.
- Fable review landed -> `02_plan/output/upgrade-round-review.md`: REJECT as submitted. False
  premises: "money/publishing/customer contact never auto-approved" (floors see only shell
  commands, `never` lifts adapter approval, one approval covers a step, no idempotency tokens for
  publish/book/charge); CLI has no OAuth/token store; A2A runner is whole-orchestration so no
  per-seat MCP tools; packs never read at run time; B4 wrote into read-only apps/web; adapter
  matrix wrong (no YouTube publish, TikTok SELF_ONLY, DMs throw). Design rewritten as v2 with a
  gate-first section (class floor, per-call binding, idempotency tokens, provenance on inbound
  text, external spend, `trent connect`, seven-place toolset registration, MCP bearer + needs_approval),
  executors reordered B3-core > B2 > B1, MCP over toolsets + Claude renderer in wave 1, RAG cut,
  nine gate questions.

## Gate decisions taken (2026-09-20, one question at a time)
1. Packaging: fleet packs with a persona block and `trent fleet packs` (A3). Bobby: make the
   personas "really cool, incredibly interesting", "like a band of mismatched bandits": each
   agent a distinct voice and edge, working as a crew.
2. Skill source: a second skill source under `packages/trent-core/skills/` (no apps/web edits).
3. Executor order: business and media in parallel, then social.
4. Inbound SMS/voice: outbound only this round.
5. Media binaries: both, docker preferred (host backend now with an allowlist; a media sandbox
   image as a follow-up the doctor prefers when present).
6. Portability: `trent mcp serve` over toolsets plus the Claude file renderer in wave 1.
Pending (Bobby dismissed the next question; waiting for instruction): 7 creator pack text-only
first vs hold; 8 RAG scope (cut E-final vs full); 9 platform applications and paid services.
- Bobby: "enough questions now be autonomous". Remaining decisions taken with the recommended
  options: 7 creator pack text-only first with an honest description; 8 RAG cut scope (E-final);
  9 Buffer accepted (5 USD/channel), X API skipped, platform applications (Meta App Review,
  TikTok audit, YouTube audit, Google Business Profile Basic Access, Twilio 10DLC) listed as
  Bobby's steps in the final report. Wave 1 launched.
- Scheduled (durable, ~/.claude/scheduled-tasks/): `trent-daily-hermes-parity` every day 02:07
  (progress summary, Hermes releases research by one Opus agent, up to five testable proposals,
  daily log committed and pushed); `trent-deferred-decisions-reminder` once on 2026-09-21 09:03
  (five deferred questions, one at a time). Session-only mirrors also set (d61aee29, afecd40c).
- Wave 1 in flight (six Opus agents): U1 safety gate (class floor, per-call binding, idempotency
  tokens, inbound provenance, external spend), U2 `trent connect`, U3 `trent brain import`,
  U4 packs + personas ("band of mismatched bandits") + core skill source, U5 `trent mcp serve`
  over toolsets + `fleet export --target claude`, U6 media host backend + transcription +
  `orchestrator.resume`.
- U3 60ca092 (brain import) and U6 (media toolset + resume) landed. U4 (packs/personas) waits on
  U5: their skill-store edits interleave (U4 frontmatter read in readFlat; U5 moved the parser to
  skills/frontmatter.ts). Doctor is at 20 checks; docs-truth keeps the counts honest.
- Wave 1 closed: U1 363cf10, U2 53796c6, U3 60ca092, U6 f403127, U4+U5 ff036d4. Working tree
  synced to HEAD. Clean-HEAD evidence below.
tsc exit=0
core build exit=0
repo-scan exit=0
      Tests  3257 passed | 1 skipped (3258)
 Test Files  327 passed (327)
vitest exit=0
- Wave 2 launched (six Opus agents): W1 Linux-binary doctor Prisma-engine failure on f403127
  (CI red; brain-import commit was green), W2 business toolset (Stripe, Calendar, Square, outbound
  SMS), W3 retrieval golden gate, W4 image generation, W5 Hermes + Codex renderers + A2A retag,
  W6 social toolset over the app adapters + Bluesky + Buffer + post queue.
- W1 landed (doctor app-memory check no longer loads Prisma; Linux binary doctor exit 3). Found: trent run from the binary on Linux with a file: DATABASE_URL hits the unshipped Postgres engine; follow-up W1.1.
- W4 landed (media_image; live proof hit 429: no image quota on the Gemini plan; Bobby's step). 
- W5 landed (Hermes + Codex renderers; live Hermes import proof passed on v0.21.2; A2A tags = toolsets).

## PAUSED by Bobby (2026-09-20)
- Landed and pushed: wave 1 complete (U1 363cf10, U2 53796c6, U3 60ca092, U6 f403127, U4+U5
  ff036d4); wave 2 so far W1 5d4c4a5 (doctor Prisma), W4 bf98635 (media_image), W5 d635d69
  (Hermes + Codex export, A2A retag). HEAD is pushed; CI to be checked on resume.
- Still running when paused (four Opus agents; their files are uncommitted in the working tree
  when they finish, nothing is staged): W2 business toolset (tools/business/**, doctor/checks/
  business.ts, docs/business.md), W3 retrieval golden gate (improve/**, fleet-memory/retrieval-
  eval.ts, orchestrator-hook.ts recall note, config [W3] block), W6 social toolset (tools/social/**,
  doctor/checks/social.ts, docs/social.md), W1.1 binary run on Linux with a file: DATABASE_URL
  (app-source/app-tiers/app-writes predicate, headless wiring).
- On resume: read each agent's final report (task notifications), verify each with
  scripts/dev/isolate.sh on a clean worktree of HEAD, commit with explicit paths and the marked
  config blocks cut by marker, regenerate schema-split.snapshot.json for any new key, push, then
  sync the working tree to HEAD and run the full clean-HEAD suite. Then wave 3 (importers, post
  queue polish, Google Business Profile reviews when access is granted, docs sync) and the
  deferred-decisions reminder fires 2026-09-21 09:03.
- Not to forget: Bobby's Gemini plan has no image-generation quota (W4 live proof 429); the
  platform applications (Meta App Review, TikTok audit, YouTube audit, Google Business Profile
  Basic Access, Twilio 10DLC) are Bobby's steps; Buffer accepted, X skipped.

## Paused state update (all wave-2 agents finished; nothing staged)
- W2 business toolset done: Stripe invoices/quotes/payment links (a Price per line), Google
  Calendar (appointment tools), Square bookings + invoices, Twilio outbound SMS (from number is an
  argument; spend = ceil(segments x 0.83c)); every write gated, previewed, idempotent; reads tag
  customer text untrusted. Tool names chosen to fit the classifier: customer_search,
  calendar_appointment_*. quote/appointment are not scope tokens (governance owner).
- W3 retrieval gate done: retrieval golden kind (founder + captured from brain_read after recall),
  recall@8 evaluator, deterministic gate (retrieval.min_recall 0.9, top-level key), frozen
  ranking surface, trent improve retrieval, sweep leaves a recall breach quarantined.
- W6 social toolset done: platforms/post/reply/inbox/insights/schedule over the app adapter +
  Bluesky direct + Buffer (text-only); queue publishes via a cron handler under the queue-time
  approval key; read tools named *_list/*_read; X/LinkedIn/TikTok direct need connect providers.
- W1.1 done: app-store predicate (usable only for postgres URLs) + guardAppDatabase fills the
  app's __prisma seam so the Postgres client is never built without Postgres; headless never
  hands the core store's file: URL to the orchestrator; Linux binary run reaches the gateway
  (stderr 0). NEW FINDINGS: (a) W6's tools/social/{publish,matrix,types}.ts import the app's
  social adapter at top level -> @/lib/store -> db.ts at CLI start-up, which re-breaks the Linux
  binary; those imports must become lazy before W6 lands; (b) the compiled binary is never
  durable (prisma/init.sql not embedded); (c) a cwd without .claude/skills makes the first seat
  step fail with ENOENT; (d) --json stdout carries two pino debug lines; (e) one accidental
  15-cent live call from a repo-root run because Bun auto-loads .env.local.
- On resume, landing order: W1.1 first, then W6 with its imports made lazy (re-verify the
  static-graph test), W2, W3; then a clean-HEAD full run; then a follow-up agent for findings
  (b), (c), (d) and the .env.local auto-load.
- Daily check 2026-09-20 02:50: clean-HEAD full suite 3296 passed / 1 skipped after regenerating the Prisma client in the isolation worktree (the prune step had removed it; isolate.sh now regenerates after pruning). No HEAD defect.

## Deferred decisions (Bobby, 2026-09-20, resumed: "get back to work")
1. Inbound SMS/voice: outbound-only stays; no webhook surface this round.
2. Media image: wire `trent sandbox build --media` now; no registry publishing.
3. Platform applications (Meta, YouTube, TikTok, Google Business Profile): Bobby will do them
   last; social runs on Bluesky + Buffer until then.
4. Creator pack: enable clipping now (state line, persona, skills call the media tools).
5. RAG deferred items: wait for a real measurement on real documents; no reranker yet.
Pause lifted. Landing order: W1.1, W6 (with lazy adapter imports), W2, W3.
- W1.1+W3 landed 928ca0f. W6.1 launched: make the social toolset's app-adapter imports lazy (static-graph test) before W6 lands; then W2.
- W2 and W6 share the seven registration files line-for-line (enum, builder branch, TOOLSET_BY_ADAPTER, setup rosters, doctor lists, mcp toolset-tools); they land as ONE commit after W6.1's lazy imports pass the static-graph test.
- Wave 2 closed: W1 5d4c4a5, W4 bf98635, W5 d635d69, W1.1+W3 928ca0f, W2+W6 fd51f62 (after W6.1
  lazy imports; finance seat now carries Stripe on purpose). Tree synced. Clean-HEAD evidence:
tsc exit=0
core build exit=0
repo-scan exit=0
      Tests  3418 passed | 1 skipped (3419)
 Test Files  352 passed (352)
vitest exit=0
- Wave 3 launched: X1 trent sandbox build --media + creator pack clipping; X2 Linux binary
  findings (init.sql embed, .claude/skills ENOENT, pino lines on --json, .env.local auto-load);
  X3 trent usage; X4 cron incidents + quota hold + queue editing; X5 session_search windows +
  auto-recovery cycles; X6 Codex/Hermes/Claude importers.
- Wave 3 landing: X3 8d4897a (trent usage), X1 659ec6e (sandbox build --media, creator clipping), X4 80a5bc6 (cron incidents, quota hold, queue editing), X2 824560d + 0d9f3ca (web skills ENOENT fix; binary durable, --json single doc, no .env.local autoload). Remaining: X5, X6.
- Wave 3 closed: X6 f898d0b (Claude/Codex/Hermes importers, quarantined unpromoted versions),
  X5 9a71a99 (session_search after/before/24h|7d|2w + exclude_session_ids; auto-recovery cycles,
  `agent.auto_recovery_cycles` default 1), b6965b4 (the --json single-document regression tests
  that 0d9f3ca left out). Tree synced to HEAD. Clean-HEAD evidence (isolate.sh, whole suite):
tsc exit=0
core build exit=0
repo-scan exit=0
      Tests  3584 passed | 1 skipped (3585)
 Test Files  368 passed (368)
vitest exit=0
  CI green through f898d0b; 9a71a99 and b6965b4 in progress at 23:16Z.

## Upgrade round: open items after wave 3
- Google Business Profile reviews: after Bobby's platform application (his step, "last").
- Hermes live A2A discovery proof: only the Hermes import proof exists.
- RAG reranker / query prefixes: deferred until a recall@8 measurement on real documents.
- `docs/doctor.md` rows for checks 19-20 (brain import, media) noted missing by W2.
- `quote` / `appointment` idempotency tokens (governance follow-up).
- `trent budget status` adopting the shared spend reader.
- Live image proof once Bobby's Gemini plan has image quota (429 today).

## Follow-up wave (2026-09-20 evening, after wave 3)
- Y1 docs/doctor.md rows 19-20 landed 2355bc3 (doc only; docs-truth + DoctorRunner green in isolation).
- Three Opus agents launched (no subagents, no commits): Y2 `trent budget status` reads through
  `buildSpendReport` so usage.ts's claim is true; Y3 `quote`/`appointment` join
  SIDE_EFFECT_SCOPE_TOKENS with a replay test; Y4 Hermes A2A discovery live proof with no model
  call and no writes under ~/.hermes (proof file docs/sessions/2026-09-20-hermes-a2a-discovery-proof.md).
- CI: green through b6965b4; 2bf5df2 and 2355bc3 queued at 23:30Z.
- Y2 landed 99a3ffe (budget status through buildSpendReport; guard test found the "" vs
  "unattributed" surface divergence). Y3 landed a21554b (quote/appointment tokens; five red tests
  first). Y4 landed a0fc407: Hermes v0.21.3 a2a_discover parsed Trent's card live with no spend;
  its a2a_call speaks A2A v1.0 (SendMessage, ROLE_USER, parts without kind) and Trent's 0.3.0 server
  answers -32601/-32005; docs claimed orchestrate fans out by tags, it reads capabilities (fixed).
- Y5 launched: A2A v1.0 wire translation at the RPC edge so Hermes calls land in the task
  lifecycle; live probe from the Hermes venv, no model call. CI: 2bf5df2 run 35544291702 success.
- CI on ac2eb98 (run 35544934870): first attempt failed on
  `tools/browser/browser.chromium.test.ts` (real Chromium through the egress proxy, 60 s timeout);
  none of the three commits since the green 99a3ffe touch browser or egress code, the file passes
  locally 3/3, and the rerun of the failed job went green. Recorded as a CI flake to watch; if it
  recurs, give that test its own timeout or move it to the sandbox job.
- Y5 landed c403e92: A2A v1.0 on the wire beside 0.3.0 (a2a/v1.ts translation; eight red tests
  first); live proof from Hermes's own client on a keyless scratch profile: HTTP 200 with a task,
  run stopped at the gateway's no-key check, spentCents 0; a2a_discover prints JSONRPC v1.0.
- Y6 launched: continuation by contextId without taskId for input-required tasks (Hermes never
  sends taskId); v1.0 error texts in v1.0 spelling.
- Y6 landed 14e1b04: per A2A v1.0 spec 3.4.3 a contextId-only message starts a NEW task (the
  lifecycle already did; pinned by context-continuation.test.ts); Hermes's client never resends a
  taskId, so answering input-required is a Hermes-side gap, recorded in docs/a2a.md; v1.0 error
  texts in v1.0 spelling (three red first). Y7 landed a1a4e04: a taskId with another context's id
  is rejected with -32602 (spec MUST; red first).
- CI: c403e92 success. Final clean-HEAD full suite + CI on a1a4e04 running at close.

## Open after the follow-up wave (all need Bobby or a measurement)
- Platform applications (Meta, YouTube, TikTok, Google Business Profile): Bobby, "last".
- Gemini image quota for the live image proof (429 today).
- RAG reranker / query prefixes: after a recall@8 measurement on real documents.
- Hermes answering an input-required Trent task: Hermes-side (its client sends no taskId).
- Release checklist steps that are Bobby's (05_release/output/release-checklist-v1.md).
- Close (2026-09-21 00:40Z): clean-HEAD full suite on a1a4e04 (isolate.sh, whole suite):
tsc exit=0
core build exit=0
repo-scan exit=0
      Tests  3608 passed | 1 skipped (3609)
 Test Files  370 passed (370)
vitest exit=0
  CI green on c403e92 (35545661538), 14e1b04 (35546188321), a1a4e04 (35549717577). Tree clean.
