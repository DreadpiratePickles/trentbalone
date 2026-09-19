# Upgrade round design: three market agents, portable agents, harness upgrades

Date: 2026-09-19. DRAFT for the Fable review and Bobby's gate. Inputs, each with file:line or URL
evidence: `01_discovery/output/upgrade-agents-audit-2026-09-19.md` (RA),
`portable-agents-research-2026-09-19.md` (RB), `harness-upgrade-audit-2026-09-19.md` (RC),
`market-agents-research-2026-09-19.md` (RD). Rulebook principles that bind this design: 1 (build
outcomes, not AI infrastructure), 7 (humans stay in command of money, publishing, customer contact),
11 (escalate architecture only when required), 12 (top model plans, cheaper models execute),
14 (stand on existing repos), 15 (cost discipline).

## 0. What Bobby asked and what the evidence says

Three agents usable in today's climate, droppable into Claude Code, Codex, Hermes and Grok, and a
better harness (LangGraph? RAG?), done surgically. The evidence narrows each:

- The three agents are mostly a tools problem, not a prompts problem. The app already has live
  social adapters for six platforms with an approval-gated calendar, but the CLI cannot execute any
  of it (RA section 2); booking, invoicing, transcription and clipping have no executor anywhere
  (RA section 3). Packaging the agents as prompts alone would violate the never-claim rule in the
  seat prompt (`apps/web/lib/agents.ts:93`).
- Portability is a remote-call problem first. No target harness can carry a budget, approval floors,
  evals, version pins or the brain (RB section 3); Grok Bot has no file surface at all. Every target
  is an MCP client, and Hermes already speaks A2A to us.
- The harness does not need a new engine. None of principle 11's six conditions holds (RC section 2).
  It needs ingestion and retrieval with a number on it: today no document can enter the brain, the
  index cuts files at 4,000 chars, and the app's own grounding path ranks by hash vectors on a
  Gemini-only profile (RC section 1).

## 1. Decision A: how the three agents are packaged

Options (RA section 4 table):
- A1 New seats. Enforcement of budget, floors and tier per agent; but each seat costs the `AgentRole`
  union plus 25 exhaustive tables and tests asserting nine, and buys enforcement of capabilities the
  CLI cannot execute yet.
- A2 Catalog specialists. One row each; but a specialist carries no prompt, tools, model or suite,
  is never scheduled by the planner, and produces no traces, so the improve loop never sees it.
- A3 Fleet packs over existing seats plus new assignable skills, with the executors built as
  toolsets (recommended). `small-business` = support, sales, finance, content; `social` = content,
  growth, analyst plus two specialists; `creator` = content plus the two video specialists. The
  pack description states exactly what executes and what is draft-only until its toolset lands.

Recommendation: A3 now, and revisit a `social` seat only when the `social` toolset exists and the
planner needs to route "reply to comments" somewhere other than content. Reason: packs cost one
entry each and inherit the improve loop, goldens, curator and brain for free (RA section 5); the
value is in the toolsets, which packs and seats share.

## 2. Decision B: which executors to build, in which order (the week-one sets)

From RD section 5 and RA section 6, ordered by per-unit cost and review requirements, each behind
an approval floor (money, publishing, customer contact are never auto-approved; principle 7):

- B1 `social` toolset wrapping the app's `live-platform-adapter.ts` and `calendar.ts` (post, reply,
  inbox, insights, schedule) for the six platforms the app already integrates, plus Bluesky direct
  (no review) and Buffer as the week-one publisher for reviewed platforms. Meta App Review, TikTok
  and YouTube audits are Bobby's applications, submitted in week one.
- B2 `media` toolset: a local clip pipeline (ffmpeg, faster-whisper or whisper.cpp, PySceneDetect,
  MediaPipe) at zero cents per clip, with hosted transcription on the Gemini key as the fallback and
  image generation through the app's image router (Gemini Flash Image, about 5 cents per image).
  Replaces the throwing transcription stub. Needs ffmpeg in the sandbox image or a host backend
  (decision B2.a below).
- B3 `business` toolset: Twilio SMS and voice (10DLC registration, no app review), Google Calendar,
  Stripe invoices, quotes and payment links, Square bookings and invoices; Google Business Profile
  reviews once Basic Access is granted (Bobby applies day one; 60-day profile age applies).
- B4 Skills per agent (quote-estimate, invoice-draft, booking-followup, review-response,
  local-business-post; content-engine, crosspost, brand-voice, x-api made assignable; hooks,
  captions, chapter maps for the creator) and V3 prompt overrides for the two video and the social
  specialists, with `seat-prompt.ts:27` fixed to the V3 lookup.

B2.a ffmpeg placement options: (i) add ffmpeg, whisper.cpp and the Python tools to the sandbox
image (`scripts/sandbox/Dockerfile`, image built to be inert today; grows it by hundreds of MB);
(ii) a host backend for the `media` toolset that shells out to host binaries with an allowlist and
the doctor reporting what is installed (no image growth; not sandboxed); (iii) both, docker
preferred when present. Recommendation: (iii), with the doctor naming the backend in use.

Costs Bobby should expect (RD): Twilio about 0.8 cents per SMS and 1.15 dollars per number per
month; Buffer 5 dollars per channel per month; X API 200 dollars per month (skip until asked);
hosted transcription 0.3 to 0.6 cents per minute; thumbnails 4 to 7 cents each.

## 3. Decision C: portability design

Options (RB section 4):
- C1 Export to each harness's native format (Claude `.claude/agents/*.md` plus `.mcp.json`, Codex
  `.codex/agents/*.toml` plus `AGENTS.md`, Hermes profile distribution; Grok Build reads the Claude
  layout). Loses budget, floors, evals, version pins and brain at the host; four formats to track.
- C2 Trent as a remote agent: `trent mcp serve` (one tool per seat over stdio and Streamable HTTP,
  reusing the A2A runner) plus the existing A2A card. Agents keep everything because they run in
  Trent; reaches Claude Code, Codex, Grok Build, the xAI Remote MCP API and Grok Bot; Hermes needs
  no new code. Loses offline use and the host's own tools inside the run.
- C3 A common package `trent-agent/2`: an Agent Plugins 1.0.0 directory (`plugin.json` with Trent's
  fields under `extensions["ai.trent.agent"]`: prompt, model tier, toolsets, denied, approval gates,
  budget cents, eval suite id, version hashes, brain files; `skills/`; `mcp.json`; `brain/`) whose
  per-harness renderers produce C1's outputs, and importers for foreign agent files.

Recommendation (RB section 6): C2 first (about four days), then C3 with the Claude renderer first
(Grok Build reads it, so one renderer covers two hosts), then Hermes (toolset names already match),
then Codex (its format "may evolve"). C1 exists only as C3's render step. Also: extend `agent.json`
to the full seat record, parse nested `metadata:` frontmatter (spec and Hermes use it), keep skill
`scripts/` and `tools/` on export, and retag the A2A card by toolset so Hermes discovers seats by
capability.

## 4. Decision D: the harness engine

Options (RC section 2):
- D1 Adopt LangGraph.js as the run engine under the wrapper. Duplicates the app's checkpointer,
  cannot own the app's run rows, and its resume-re-executes-the-node semantics demand idempotency
  in a seat loop we cannot edit (apps/web is read-only).
- D2 Borrow two patterns without the dependency: `orchestrator.resume(runId)` over the app's
  existing hydrate and select-ready-steps functions, and one typed resume Command. About one day.
- D3 Leave the engine alone.

Recommendation: D2. None of principle 11's escalation conditions is present; resume is the one
durability gap a cron or heartbeat run actually hits. The OpenAI Agents SDK and the Claude Agent SDK
are also rejected as cores (RC section 5): they would run seats outside the app's plan, critic and
consolidate phases.

## 5. Decision E: RAG scope for the company brain

Options:
- E1 Ingestion only: `trent brain import` for Markdown, text and CSV, chunked with heading and page
  awareness, sha256 and provenance front matter, the existing Gemini embedder, chunk-id citations
  into the CONTEXT tier with `brain_read` expansion. About two days.
- E2 E1 plus PDF, DOCX and XLSX extractors (pdftotext or pdfjs, mammoth, SheetJS), a retrieval
  golden set with a deterministic recall@8 gate in the improve loop, and a local ONNX cross-encoder
  reranker behind `memory.reranker: local | llm | none`. About six days.
- E3 E2 plus contextual chunk prefixes (Anthropic's contextual retrieval, cents per document on the
  spend ledger) and routing the app's wiki grounding to the configured provider or naming it as
  hash-ranked in the doctor. About eight days.

Recommendation: E3, in that order, with the golden gate landing before the reranker so every ranker
change has a number. Not this round (RC section 5): a vector database, GraphRAG or a temporal graph
for documents, OCR of scanned PDFs, an LLM judge for retrieval, retrieved chunks in the stable tier.

## 6. Waves (after the gate; at most six Opus agents, disjoint files, isolate.sh per commit)

Wave 1 (foundations, no external accounts): D2 resume; E1 ingestion; the retrieval golden gate (E2
part); `trent mcp serve` (C2); packs and assignable skills and V3 overrides with the `seat-prompt.ts`
fix (A3, B4); `media` toolset local pipeline with the transcription stub replaced (B2 core).
Wave 2: `social` toolset over the app adapters plus Bluesky and Buffer (B1); `business` toolset
Twilio, Calendar, Stripe (B3 core); PDF/DOCX/XLSX extractors and the reranker (E2 rest); `trent-agent/2`
manifest and the Claude renderer (C3 core); image generation in `media`.
Wave 3: Hermes and Codex renderers and importers; Square and Google Business Profile reviews; the
post queue; contextual prefixes and the wiki-grounding honesty item (E3); A2A card retag.
Live proofs per wave on Bobby's key; approval-floor tests for every side-effecting tool.

## 7. Decisions Bobby must make at the gate
1. A: packs now (A3) versus new seats (A1).
2. B2.a: ffmpeg in the sandbox image, a host backend, or both.
3. B: which platform applications Bobby submits in week one (Meta App Review, TikTok audit,
   YouTube audit, Google Business Profile Basic Access, Twilio 10DLC), and which paid services are
   acceptable (Buffer at 5 dollars per channel; X API at 200 dollars per month is proposed as skip).
4. C: C2 then C3 (recommended) versus native exports only (C1).
5. D: borrow resume (D2) versus adopt LangGraph (D1).
6. E: RAG scope E1, E2 or E3.
7. Whether the creator pack may ship text-only first (honest description) while the media toolset
   lands, or must wait for it.
