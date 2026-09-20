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
