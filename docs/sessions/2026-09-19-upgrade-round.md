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
