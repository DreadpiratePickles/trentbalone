# Harness landscape and local models, 2026-09-26

Bobby: "do some real in depth research about the best harnesses out here, gpt claude and
perplexity computer etc, and see what we're lacking and how we can incorporate this so people can
use local models on it and just see precisely where we lack." Deliverable: an evidence-backed
landscape and gap analysis with a local-model plan; no implementation in this session unless
Bobby says so.

## Method
Five Opus research agents (no subagents), primary sources only with URLs; one Trent-side audit
against HEAD with file evidence; Fable synthesis into 01_discovery/output/harness-landscape-
2026-09-26.md and 02_plan/output/local-models-plan-2026-09-26.md.

## Launched 01:05Z (five Opus agents, no subagents, read-only, one file each)
- R1 harness-openai: Codex CLI/app, Agents SDK, Responses built-in tools, ChatGPT agent, local
  models via --oss/Ollama/LM Studio.
- R2 harness-anthropic: Claude Code, Agent SDK, Managed Agents, Cowork; local/third-party model path.
- R3 harness-others: Perplexity Computer (a full page), Gemini CLI, OpenHands, Goose, Cline/Roo/
  Kilo, Cursor, Devin, Manus, Amp, Warp, Aider, 2026 launches with traction.
- R4 local-models: runtimes (Ollama, LM Studio, llama.cpp, vLLM, MLX), models by size class with
  tool-call reliability, local embeddings, how harnesses handle local models, failure modes,
  minimum viable stack per hardware tier, a testable requirements checklist for a harness.
- R5 trent-local-path-audit: the model path at HEAD with `models.provider: ollama`, a live run with
  no cloud key if Ollama is installed, embeddings/retrieval without a key, the gap list with
  file:line and a failing test per gap.
Fact at start: the gateway already accepts ollama/lmstudio/deepseek/groq aliases
(model-gateway/providers.ts) and setup treats ollama/lmstudio as keyless (setup/detect.ts).
- R2 landed (01_discovery/output/harness-anthropic-2026-09-26.md, 393 lines). Distinctive: auto-mode
  classifier (a second model reviews each action), OS-enforced bash sandbox with credential masking
  (open-sourced), dynamic workflows (a JS orchestration script the runtime executes, 16-256
  concurrent, resumable), four multi-agent shapes, 33 hook events, compaction that re-injects
  instructions/memory/plan/skills, sessions that move between devices, four scheduling levels,
  Managed Agents with outcome graders and memory stores, measured plugins (`claude plugin eval`).
  Local models: no first-party path anywhere; only ANTHROPIC_BASE_URL at the wire level, explicitly
  unsupported for non-Claude models. Conclusion: Trent's local support stays in its own gateway.
- R3 landed (01_discovery/output/harness-others-2026-09-26.md). Perplexity Computer (2026-02-25):
  cloud digital worker, subagents in isolated environments, tasks for hours to months, 20+ models
  with a switchable lead, Effort levels, a Model Council, 400+ connectors + MCP, credential vault,
  per-tool "Always ask", Brain memory (source-linked, refreshed overnight, wiki pages), work from
  web/mobile/Slack/M365/email/a 24/7 Mac mini; ON-DEVICE mode on 24 GB+ hardware running Qwen 3.8
  27B (or Perplexity's post-trained one) with connectors rewritten as compact CLI tools, skills on
  demand, and a frontier "advisor" the local model may ask only with approval after a privacy
  check. Field: Goose (llama.cpp in-app, model picked for your memory; tool calls reliable only on
  Gemma 4, 4-8K context), OpenClaw (managed llama.cpp, 64K, hosted->local fallback, lives in 20+
  chat channels), OpenHands (Qwen3.6-35B-A3B via LM Studio/Ollama/vLLM, 22K+ context; Agent Canvas
  over ACP), Cline Desktop (import a Claude Code/Codex session onto an open-weight model), Gemini
  CLI Rewind, Goose Adversary Mode, Cursor Projects coordinator, Devin video proofs, Manus Branch,
  Amp Orbs, DeepSeek Harness (236k stars since Aug 13, any endpoint, no local guidance). Roo Code
  shut down 2026-05-15; Gemini CLI, Warp and Cursor cannot use a local main model.
- R1 landed (01_discovery/output/harness-openai-2026-09-26.md, 198 rows). New: the Agents API
  (2026-09-10, beta) runs the open-source Codex harness as a managed service (durable sessions,
  hosted sandboxes, nine third-party sandbox providers; no local/third-party model, no ZDR).
  Distinctive: one harness three ways (local, managed, `codex exec-server` in your sandbox);
  sandboxed by default on every desktop OS (seatbelt/bubblewrap+seccomp/native), workspace-write,
  network off; auto-review by a reviewer agent at the sandbox edge; secrets as placeholders swapped
  by a proxy for approved hosts; server-side encrypted compaction; deferred and grouped tools with
  keyword tool search; Programmatic Tool Calling (JS over many tools in an isolated runtime);
  multi-agent create/message/wait/interrupt as typed events (6 concurrent); Record & Replay skills
  from a demonstration; import from Claude Code/Cowork/Cursor. Local: `codex --oss` with
  oss_provider ollama|lmstudio, default gpt-oss:20b (16 GB) / gpt-oss-120b (80 GB), 64k context
  recommended; Responses API only (Chat Completions removed Feb 2026); MCP tools sent in a wrapper
  local servers do not understand, so they never reach the model; no native edit tool for
  third-party models; subagents ignore model_provider; Agents SDK local via Chat Completions with
  tool search/deferred/PTC rejected. Retired: Evals platform and Agent Builder on 2026-11-30,
  Assistants API 2026-08-26, codex mcp-server. Codex does not strip *KEY*/*SECRET*/*TOKEN* from
  spawned commands by default.
- R5 landed (01_discovery/output/trent-local-path-audit-2026-09-26.md). VERDICT: Trent cannot run
  on local models today. `provider: ollama` sets; planner and critic reach Ollama; every SEAT call
  is sent as gpt-5.2 / gpt-4.1-mini (404) because gepa/index.ts:16 -> apps/web/lib/gepa.ts:31 ->
  ai-client.ts fixes the model table at CLI startup before the config's models apply (G1); on this
  machine the planner itself timed out at 60 s (ai-client.ts:117) on the 11 GB Qwen 27B (35 tok/s
  prompt, 1.3 tok/s generation, swapping) (G2). Workaround: export OPENAI_MODEL_FAST/DEFAULT/
  STRONG/CRITIC=<model>; against a fake OpenAI-compatible server every call then used the local
  model, tool calls parsed and ran, 0 cents under ollama. LEAK (G4): a pinned model named
  mistral:7b was sent to api.mistral.ai with the placeholder bearer "local" (401); names containing
  mistral/gemini/claude are refused as seats (seat-gateway-port.ts:62-69, call-policy.ts:107).
  Other gaps: quick setup refuses --provider ollama and asks for OLLAMA_API_KEY (G3); the
  consolidator's callText bypasses the gateway (G5); the improve judge falls back to
  gemini-3.5-pro (G6); false DEGRADED banner (G7); doctor never checks the local server/model and
  exits 0 with Ollama unreachable (G8); the embedder asks Ollama for text-embedding-3-small, 404,
  silently lexical (G9); wiki-embeddings.ts makes the same 404 every step (G10); an Ollama :cloud
  model priced 0 and called local (G11); doctor fails on Docker down (G12); connectivity resolves
  only api.openai.com (G13); ledger records gpt-* names (G14); full setup says OLLAMA_API_KEY set
  (G15); the SDK timeout classed internal, never retried (G16); nothing checks Ollama's context
  size, prompts silently truncated (G17); thinking models vs the judge's 256-token limit (G18).
  Brain import works without a key; recall is lexical-only in effect. No small model pulled
  (needs Bobby's OK for a download); the audit permitted no cloud call and one unintended request
  left the machine (the G4 leak, with no real key).
- R4 landed (01_discovery/output/local-models-2026-09-26.md, 554 lines). Minimum stacks: 16 GB Mac
  Qwen3.5-9B Q4 + Qwen3-Embedding-0.6B + whisper base; 24 GB GPU / 32 GB Mac Qwen3.6-27B or
  Qwen3.8-27B Q4 (~17 GB), 48-64 GB Qwen3.6-35B-A3B, gpt-oss-20b as the speed choice; 128 GB+
  gpt-oss-120b or Qwen3.5-122B-A10B for planner/critic with 35B-A3B seats. Requirements:
  constrained output (json_schema) on local providers with the action string flattened to
  {tool, args}; effective context window read from the server and prompts refused over budget;
  byte-identical prefixes, slot-limited concurrency, prefill-sized timeouts; repair-then-retry,
  never fake success; a local-stack doctor with a tool-call smoke test and TTFT. Failure modes:
  silent context truncation (Ollama 4K default under 24 GiB), broken tool calls (tabs in JSON,
  truncated args replaced by {}, abstain rates 45-54% on Llama 4/3.3), cold prefill and cache
  thrash across eleven roles. Trent-specific: default llama3.2 scores 21.95% / 4% multi-turn.
- Plan written: 02_plan/output/local-models-plan-2026-09-26.md (L0 runs and tells the truth;
  L1 reliable on small models; L2 the product path; three decisions for Bobby, none blocking).
- Bobby (01:40Z): "take all the things you've learnt and apply it to making a better product; also
  recreate a base harness for people that just want to use it like Hermes without the 9 agents."
  Wave L0 launched (five Opus agents, no subagents): L0-1 routing truth + the mistral leak +
  :cloud labelling; L0-2 every OpenAI-compatible provider through the wrapper client, prefill-sized
  timeouts, prompt budget, slot-limited concurrency; L0-3 setup for local providers, honest
  DEGRADED, local judge, tier default model (pulls one small Qwen); L0-4 doctor Local Model check
  (23rd), connectivity, Docker warn; L0-5 local embeddings with calibrated floors, the app's
  wiki-embeddings 404 stopped, local recall recorded. R6 matrix still running. Next: the base
  harness ("solo mode") design, then wave S.
- Solo mode design written: 02_plan/output/solo-harness-design-2026-09-26.md. Decision: a second
  runner behind the existing AgentRunner port yielding the same OrcEvents, so every surface, the
  ledger, approvals and checkpoints work unchanged; `agent.mode: fleet|solo`, `trent --solo`.
  Waves S1-S4 after L0 frees slots; an Opus adversarial review runs beside S1.
- R6 landed (01_discovery/output/harness-matrix-2026-09-26.md, 56 rows: parity 14, ahead 6,
  partial 24, missing 9, deliberately-not 3). Synthesis written: 01_discovery/output/harness-
  landscape-2026-09-26.md with the ten gaps mapped to waves L0-L2, S1-S4, H1-H5 and Bobby's steps.
- S1 (solo core loop) launched.
- L0-4 reported (unlanded): Local Model check (23rd; runtime + version, model present with the pull
  line, effective context from the loaded model with the OLLAMA_CONTEXT_LENGTH hint, slots, a
  five-case tool-call smoke through the wrapper's gateway, first-token time at ~4K), connectivity
  resolves the provider's real host (local: one request to its URL, no cloud lookup), Docker down
  is a warn naming the local fallback (the REPL and trent run already fall back), credentials line
  for local. LIVE on qwen3.5:9b (6.6 GB, pulled by L0-3): doctor exit 0, 23 checks, context 32768;
  tool-call smoke 1/5: the model wrote `"action": "read_file", {...}` instead of the `<tool>
  <json>` string; timings unusable (load ~1000, swap 14.8/15.4 GB, other agents' Ollama calls
  overlapping). Closed port: exit 3 naming the URL. Consequences: constrained JSON `{tool, args}`
  on local providers (L1) is the prerequisite for small models, and live local proofs run one at
  a time from now on.
- L0-3 reported (unlanded): `trent setup --mode quick --provider ollama|lmstudio` needs no key,
  checks the runtime, proposes a model by memory (qwen3.5:9b < 32 GB; qwen3.6:27b at 32 GB+;
  qwen3.6:35b-a3b at 64 GB+), exits 3 with runtime-unreachable / model-not-pulled and the exact
  pull line, `--pull` after a confirmation; DEGRADED means no usable provider (one line naming the
  URL and `ollama serve` when the runtime is down); the judge refuses a hosted, priced or :cloud
  fallback under a local provider; getting-started "Local models" section with a drift test.
  Pulled qwen3.5:9b (6.6 GB, 96 s). LIVE: setup JSON success; REPL boots with no banner; `trent
  run "Say the word ready"` reached the model (planner 6m4s, seat 9m57s under load ~467) and the
  seat was cut by the app's 600 s job timeout; the model thinks by default (201 tokens at 2.7
  tok/s; 2 tokens with think:false). Adds to L1: thinking off for local seats, and the app's job
  timeout sized for local. Open: providers.ts:58 still defaults to llama3.2 when a config's model
  is empty (L0-2's file).
- S1 landing: first attempt failed at regen-snapshot because the input variant carried L0-2's
  unlanded models.local line; rebuilt from HEAD + the agent key only; rerunning.
- L0-1 reported (unlanded): env-defaults.ts applies the profile's model names before any app
  code loads (new orchestrator/model-env-early.ts, app-free; model-env.ts re-exports it and, under
  a local provider, forces MODEL_ALLOWED_PROVIDERS to the local endpoint); call-policy routes a
  pinned model to its alias's own endpoint, never a provider guessed from the name, with no
  fallback under a local alias; seats are no longer refused by name; a `:cloud` model on a local
  runtime is "hosted via ollama", tier-priced, unpriced: true. Red first (seats sent gpt-5.2 /
  gpt-4.1-mini; mistral:7b routed to mistral; a failed local call fell back to gemini-2.5-pro).
  PROOF: local-routing.test.ts runs the real gateway and the app's real client against a local
  fake plus a trap that every hosted base URL points to, with fetch restricted to 127.0.0.1: a
  pinned mistral:7b and seats named mistral/gemini/claude reach only the local server; the trap
  receives nothing. Fake-server run: 12 calls all on mistral:7b, 4 ledger rows, 0 cents. Follow-up:
  hosted aliases (deepseek, groq) route pins to their own endpoint but their seat fallback chain
  is not narrowed.
- Council review landed (02_plan/output/solo-harness-review-2026-09-26.md): APPROVE WITH CHANGES,
  35 findings, 9 blockers. Runner-level (S1.1, launched): taint and policy history scoped to the
  session (B1); answer() only for ask_human/clarify and gate frames name the held call (B2); no
  hold bounce loop (B6); one tool-call format, the model's own <tool_call>{"name","arguments"}
  with <think> stripped and constrained JSON on local (C1); in-run context budget and tool-result
  cap (C2); parked runs persisted, never lost silently on restart. Surface-level (sent to S2):
  the runner is the only writer of a conversation (A1); one runner per conversation with a router
  and a resume driver (A2); a card per held call (A3); solo on the audit chain (B4); unattended
  surfaces refuse holds (B8). S3 inherits: compaction flushes through the wrapped memory adapter
  carrying the session taint, prunes old tool results, rebuilds the frozen prefix (B3, change 5).
  Also: delegate_task returns not_available in solo; zero-cent groups hidden in usage --by seat.
- L0-2 reported (unlanded): ollama, lmstudio, deepseek, groq and openai stream through the
  wrapper's client (include_usage; cached tokens incl. llama.cpp timings.cache_n); reasoning_effort
  IS accepted by Ollama (when /api/show lists thinking) and llama.cpp ("none" disables thinking),
  sent to OpenAI reasoning models only, not to LM Studio/DeepSeek/Groq; models.local.ttft_seconds
  300 / idle_seconds 120 for local, hosted keep 60 s; every timeout retried once; local calls use
  node:http (Node fetch caps headers at 300 s); prompt budget from the LOADED model's window
  (/api/ps, Modelfile num_ctx, LM Studio instance, llama.cpp /props, else 32768) refuses
  over-budget prompts naming the tier to trim; max_in_flight 1 on Ollama, 4 on LM Studio, per
  endpoint; a stream abandoned early no longer holds the local slot (leak fixed). LIVE qwen3.5:9b
  under load 170-970: planner 3,773 tokens, TTFT ~91 s, 893 tokens at 3 tok/s; step 5,935 tokens,
  TTFT ~157 s, 1,267 THINKING tokens; killed by the app's 10-minute job timeout
  (apps/web/lib/queue.ts, TRENT_JOB_TIMEOUT_MS). L1 adds: TRENT_JOB_TIMEOUT_MS sized for local
  through models.local; reasoning_effort none by default for local seats; heartbeat/improve build
  their own gateways and miss models.local.
- L0-5 reported (unlanded): memory.embedder.provider ollama|lmstudio|llamacpp|none|google with
  embedder-local.ts (Ollama /api/embed truncate:false, batches, cache by provider/model/task
  type), calibrated floors (qwen3-embedding:0.6b, 639 MB: 0.46 no prefix, 0.32 with the query
  instruction, the default), one WARN then lexical when the runtime is down; doctor embedder
  check live: dimensions, floor, sanity 3/3, pull line, "lexical only" for none. RECALL on the
  docs corpus, local hybrid 0.600 / recall@3 0.486 / MRR 0.480 / paraphrased 0.417 vs Gemini
  0.629 / 0.571 / 0.529 / 0.417 at 0 cents; the query instruction is what finds paraphrases
  (5/12 vs 1/12); weak spot: abstains on 0/5 unanswerable (floor set on short sentences).
  Needs at landing: one line in apps/cli/src/runtime/headless.ts (~360) passing memory.embedder
  into the model env (G10 wiring). BOBBY'S DECISION: the app's own embedding calls
  (apps/web/lib/wiki-embeddings.ts, semantic-router.ts) are silenced only by OPENAI_API_KEY; under
  embedder none they still 404 on a local runtime, and with a hosted key they send the objective
  to api.openai.com; the fix is a one-line gate in each file, an apps/web edit outside the two
  granted exceptions.
- Landed: L0-4 7c96232 (doctor Local Model check), L0-3 f90cf41 (local setup, DEGRADED truth,
  local judge). L0-1 and L0-2 landing in the background (L0-1's first attempt carried L0-5's
  unlanded embedder import in model-env.ts; cut and rerun). Launched with the free slots: H3 signed
  webhook routes that start a run (HMAC / Stripe / GitHub signatures, dedupe 24 h, untrusted
  provenance, cost cap, delivery store) and L2 `trent setup --mode local` + docs/local-models.md.
  In flight: S2 surfaces, S1.1 runner hardening, H1 approvals reviewer, H2 MCP OAuth, H3, L2.
- H1 reported (unlanded): governance.auto_review {enabled false, model?, max_class read|write|
  external_send|money, max_amount_cents, currency, recipients[]}; only bound held calls (never
  step approvals, ask_human or held memory writes); policy check in code first, then the model's
  strict JSON verdict; approve/deny through ApprovalBridge.decide with actor auto-review:<model>;
  escalate, malformed or a failed call leaves the row (retried next pass); every decision on a
  hash-chained <profile>/approvals-audit.ndjson verifiable by walkAuditChain; a reviewer approval
  is reversible with `trent approvals reject` until the call has run (stamped in
  bound-approvals.require). Open: an automatic trigger (today only `trent approvals list
  --review`; the service daemon or heartbeat should run a pass); a held row does not record
  whether its step read untrusted text.
- H2 reported (unlanded): OAuth 2.1 for remote MCP servers per the MCP authorization revision
  2026-07-28 (RFC 6750 challenge, 9728 protected-resource metadata, 8414/OIDC discovery with exact
  issuer match, 7636 S256-only PKCE refused when not advertised, 7591 dynamic registration, 8707
  resource parameter, 9207 iss check, 8252 loopback reuse); tokens in the profile secrets under
  MCP_<NAME>_* names, config holds only the ${...} reference; refresh within 5 min of expiry and
  on 401; bearer only to the MCP origin, token requests with the own-credential header; `trent mcp
  add --oauth`, `mcp test --oauth`, `mcp list` shows connected/expired/needs-login; doctor warns.
  LEAK FIXED: the egress fetch followed redirects re-sending every header, so a 307 from an MCP
  server handed its bearer to any host (probe printed the static bearer at the other host); now
  same-origin only. Open: CLI add/test run no egress proxy so cannot connect to http servers
  after login; doctor reachability reads mcp.json not mcp_servers; no Client ID Metadata
  Documents; no 403 insufficient_scope re-auth.
- H4 (messaging adapters: Matrix, Mattermost, LINE, ntfy) launched.
- S1.1 reported (unlanded; needs L0-2's prompt-budget.ts landed first): taint and policy history
  belong to the conversation, saved after every tool result, restored on reopen (B1; also found
  that S1 asked requiresApproval outside the run context so network-after-secret never fired
  within a run); answer() releases only ask_human/clarify and gate frames name the held call (B2);
  only a dryRun hold parks, an approved call runs once and its repeat is answered from the
  idempotency store, a differing call gets one new row naming each changed argument (B6); one
  format, the Hermes/Qwen <tool_call>{"name","arguments"} body normalised to `name {json}` so keys
  and rows do not move, <think> stripped, newlines in JSON strings repaired, prompt examples
  rewritten, responseFormat passed through with the {"tool_calls"}/{"answer"} envelope (C1);
  tool results capped at 8,000 chars (agent.solo.max_tool_result_chars) and over-window prompts
  refused with a verdict naming the sizes (C2); parked runs persisted before the gate frames go
  out, listed by parked() and continued by resume(runId) after a restart, else the row is marked
  abandoned and the conversation gets one "not run" line (restart). 84 solo tests. The new
  format's live smoke on the 9B is NOT measured (load stayed above 20).
- Landed L0-2 75a26cb. Landing in sequence (background): L0-1 (config-doc variant with the bare
  /v1 wrapped, model-env minus [L0-5]/[L1] marks), L0-5, H1, H2, S1.1 (runner and SessionStore
  minus [S2] marks). Launched H5 (browser attach over CDP behind the gate). In flight: S2, H3,
  L2, L1 (also wires L0-5's headless line), H4, H5.
- H3 reported (unlanded): gateway.webhooks {host 127.0.0.1, port, routes[{name, path, signature
  hmac-sha256|stripe|github|none-localhost-only, secret_env (an env NAME; a pasted value is
  rejected), objective_template with {{payload.x}} only, mode, seat?, max_cost_cents?,
  dedupe_key? (default body SHA-256), events?, rate_per_minute 30, tolerance_seconds 300,
  signature_header?}}; the signature is checked on the raw body in constant time before parsing
  (Stripe t/v1 with tolerance both ways; GitHub X-Hub-Signature-256; localhost-only needs a
  loopback caller on a loopback listener); 405/413/401/503-naming-the-variable/400/200-ignored/
  200-with-the-original-run-id on a 24 h repeat (survives restart; two copies start one run; a run
  that never started frees its key)/429 with Retry-After/202 with the run id; the first message
  opens with "[provenance: untrusted via webhook:<route>]" and the run input carries provenance
  untrusted and the cost cap; deliveries in <profile>/webhooks/deliveries.jsonl; `gateway start`
  serves routes under the profile lock; `gateway status` shows the last deliveries. Needs S2's
  runtime seams (runnerFor(mode) for a route whose mode differs, 503 today; the policy dispatcher
  to seed the inbound ring entry so send-after-untrusted fires) and H1 should record the inbound
  seed on the approval row so auto-review refuses such sends.
- Landed: H1 5bab958, H2 2095c7d, S1.1 35fd43b. L0-1 still red on docs-truth (diagnosing the
  exact claim); L0-5 depends on L0-1's model-env-early.ts; L2 depends on L0-5's memory.ts. Order:
  L0-1 -> L0-5 -> L2 -> H3.
- L2 reported (unlanded): `trent setup --mode local` detects Ollama / LM Studio / a llama.cpp
  server at --base-url, lists models with size and role (chat / embedding / cloud; the abliterated
  27Bs are "chat, no tools"), picks the tier model or a smaller pulled one, the embedder
  qwen3-embedding:0.6b else nomic-embed-text else lexical, --pull with one confirmation per model,
  writes provider, model, memory.embedder, agent.mode solo (unless --fleet), reasoning_effort none
  when the model supports thinking control, leaves terminal.backend alone when Docker answers;
  exits 3 runtime-unreachable naming every URL tried, or model-not-pulled; --dry-run reads only.
  On this 32 GB machine it would write qwen3.5:9b (fallback; the tier's qwen3.6:27b is not pulled).
  docs/local-models.md (209 lines) with the measured numbers; live run skipped (load 294).
- L0-1's docs-truth failures diagnosed: the config-doc variant predated H1's landing (missing the
  documented `governance` key) and a bare URL ending in /v1 outside backticks; variants are now
  rebuilt from current HEAD with URLs backticked (a `slashfix` step in the landing script).
  Landing in the background: L0-1 -> L0-5 -> L2 -> H3. In flight: S2, L1, H4, H5.
- H4 reported (unlanded): Matrix (spec v1.11: whoami, sync long-poll with a since cursor, join on
  invite, two-member rooms are DMs, m.room.message with m.thread relations, m.reaction, media
  download for voice notes), Mattermost (API v4: users/me, posts with root_id threads, reactions,
  channels, files, websocket with authentication_challenge/hello/posted/reaction_added; no buttons
  because Mattermost posts button presses unsigned, a reaction decides the card), LINE (Messaging
  API v2: reply token while fresh then push with X-Line-Retry-Key, quick-reply postbacks, media
  content for voice notes, X-Line-Signature over the raw body before parsing, duplicates dropped by
  webhookEventId), ntfy (publish JSON with up to three http action buttons, /<topic>/json?since=
  reply stream, /v1/health, bearer token; the reply topic is what gets paired; buttons never carry
  the token). Each adapter's tests drive the real GatewayManager (pairing code, routed once paired,
  an approval card decided on each platform; LINE forged request 401 over real HTTP). README "12
  adapters"; docs/gateway.md rows and section. Follow-ups (P3): `gateway start` opens the
  WebhookServer only when an H3 route exists, so LINE (and WhatsApp) webhooks listen only then;
  `gateway setup <platform>` writes <PLATFORM>_BOT_TOKEN, matching only Mattermost; tools/index.ts
  is at 506 lines in the tree (someone's unlanded edit; wrapped-modules will refuse it).
- Landed: L0-1 77373a0, L0-5 4b6f20c, L2 5989ac8. H3 red in isolation only because servers.ts now
  carries S2's wiring of the runnerFor/seedInbound seams; H3 lands with S2. Landing H4.
- S2 reported (unlanded): precedence launch override (--solo, `trent solo`, `run --solo`) >
  agent.mode > fleet; the REPL, run, cron run|start, gateway start, a2a serve and acp read the
  flag, the daemon/heartbeat/jobs/goal/mcp serve follow agent.mode, the TUI stays fleet-only.
  Council: A1 the runner is the only writer (one turn with one tool call leaves exactly
  [user, assistant, tool, assistant] on disk); A2 a router keeps a runner per REPL session, gateway
  thread and A2A context, a late decision resumes the right run by id; A3 a card per held call;
  B4 solo writes the fleet's orchestration.* audit rows through the app store and every frame
  reaches the bus hooks and trace sink; B8 the REPL parks, the gateway parks only with
  gateway.owner, trent run parks only on a terminal, A2A parks questions only, ACP/cron/heartbeat
  refuse and file no row. S1.1 wiring done (sessionId, state, bindings; tool-result cap and the
  local window; saved parks reopened after a restart; a row decided via trent approvals resumes on
  the gateway's next drain). H3 seams done: runtime.runnerFor(mode) and seedInbound(runId, source)
  (a seeded webhook run's first send parks on send-after-untrusted). Also fixed: `trent --profile
  work` printed usage instead of opening the REPL. Not done: ACP refuses every held call; a park
  left by a killed REPL is kept but not offered; solo session messages carry no cost_cents (usage
  is right); fleet compaction is off for solo until S3.
- Landed H4 ee84083. S2 + H3 landing in the background. H5 reported (unlanded): attach mode as
  an argument (`browser_navigate {"attach": true}`, tool count unchanged) under tools.browser.attach
  {enabled false, cdp_url 127.0.0.1:9222, profile_hint}; before any approval: attach enabled,
  cdp_url loopback only, SSRF + intercept_domains allowlist on every navigation and re-checked on
  the tab's current host per call, typing into password/one-time-code fields refused, key presses
  refused while one has focus, console expressions refused; navigate/back/click/type/press/scroll
  each wait for a customer_facing approval bound to site + element + occurrence count so one yes
  runs one call; reads ungated; an empty tab is reused else a new one opens, never the owner's
  content tab, front before each action, detach closes nothing; no proxy in the path and no proxy
  token ever sent; hash-chained <profile>/browser/attach-audit.ndjson without typed text. BUG FOUND
  AND FIXED: the password-field refusal never worked against a real browser (Playwright treated the
  field check as an expression), so "hunter2" was typed into a real type=password field; a
  real-Chromium test covers it now. noDefaults: true so the owner's downloads and settings are not
  touched. tools/index.ts is at the 500-line limit.

## HANDOFF (Bobby resets context here; 2026-09-26 ~05:30Z)
Read this section, then AGENTS.md, CLAUDE.md and the rulebook, then resume. Do not re-audit what is
evidenced above.

### What is on the branch (feature/trent-fleet-v2, pushed)
Research (all 2026-09-26, 01_discovery/output/): harness-openai, harness-anthropic, harness-others
(Perplexity Computer + field), local-models, trent-local-path-audit, harness-matrix (56 areas:
parity 14 / ahead 6 / partial 24 / missing 9), harness-landscape (the synthesis: ten gaps mapped to
waves). Plans (02_plan/output/): local-models-plan (L0/L1/L2), solo-harness-design, solo-harness-
review (council: approve with changes, nine blockers, all addressed by S1.1/S2/S3).
Code landed today, in order: e0e13ab S1 solo runner; 7c96232 L0-4 doctor Local Model check (23rd);
f90cf41 L0-3 local setup/DEGRADED/local judge; 75a26cb L0-2 wrapper client for every OpenAI-
compatible provider, prefill timeouts, prompt budget, slot cap; 5bab958 H1 approvals reviewer
model; 2095c7d H2 MCP OAuth 2.1 (+ redirect bearer leak fixed); 35fd43b S1.1 runner hardening;
77373a0 L0-1 local routing truth (+ the mistral leak closed); 4b6f20c L0-5 local embeddings;
5989ac8 L2 `trent setup --mode local` + docs/local-models.md; ee84083 H4 Matrix/Mattermost/LINE/
ntfy. IN PROGRESS at handoff: the S2 + H3 landing (solo on every surface; signed webhook routes)
was running in the background via scripts/dev/isolate.sh; check `git log --oneline -3` for a commit
"feat(solo,webhooks): solo mode on every surface; signed webhook routes start a run". If absent,
the working tree still holds S2's and H3's files (their lists are in docs/sessions/2026-09-26-
s2-solo-surfaces.md and h3-webhooks.md); land them with the procedure below.

### Agents that may have left uncommitted work in the tree (each writes its own session log)
- L1 small-model reliability: constrained JSON on local providers (the seat port re-renders JSON
  into the app's action string), tool-call repair, thinking off for local seats, TRENT_JOB_TIMEOUT_MS
  from models.local, heartbeat/improve gateways honour models.local, hosted escalation behind
  approval, plus L0-5's headless.ts memory.embedder line. Log: docs/sessions/2026-09-26-l1-small-
  models.md. Files: marked `// [L1]` hunks in model-gateway/**, orchestrator/{seat-gateway-port,
  model-env}.ts, config/sections/models.ts, new model-gateway/tool-call-repair.ts, headless.ts.
- H5 browser attach: FINISHED, unlanded. Files listed in docs/sessions/2026-09-26-h5-browser-
  attach.md (tools/browser/attach*.ts, session.ts, page-types.ts, launch.ts, schemas.ts, index.ts,
  config/sections/tools.ts [H5] block, tools/index.ts one marked line, docs/browser.md).
- S3 solo continuity (compaction through the wrapped memory adapter, skills on demand, delegation
  in solo, checkpoints, cost_cents on solo messages, resume offer): log docs/sessions/2026-09-26-
  s3-solo-continuity.md; files: solo/** additive + marked [S3], sessions/compaction.ts, tools/delegate.
- P3 follow-ups (webhook listener opens for webhook-only adapters, gateway setup env names per
  platform, auto-review pass on the daemon/heartbeat tick, untrusted_inbound stamp on held rows,
  platform comments/docs): log docs/sessions/2026-09-26-p3-followups.md; marked [P3] hunks.
If an agent's log is missing, its work did not finish: relaunch from the brief recorded in this
file (search "P3 follow-ups", "S3 solo continuity", "L1 reliable").

### Landing procedure (unchanged, proven all day)
`export TRENT_DEV_SCRATCH=<session scratchpad>; scripts/dev/isolate.sh <test paths> -- <files>
[published=variant ...]`; gate on `ISOLATED rc=0`; commit by explicit paths; push. Shared files get
VARIANTS: `scripts/dev/hunks.py <file> <out> '<regex>'` keeps only matching diff hunks against
HEAD; a marked-line drop (see the `dropmarks` python in the transcript: drop lines containing
`[TAG]` and comment blocks starting `// [TAG]`) removes another agent's hunks; the fixture
`schema-split.input.json` variant is HEAD's JSON with only this task's top-level keys merged from
the working tree; regenerate the snapshot INSIDE the worktree with `npx tsx scripts/dev/regen-
snapshot.mjs`; docs/configuration.md variants must backtick any bare URL ending in /v1 or the
docs-truth slash-command scan fails; docs-truth also checks README command counts (36/152 after
S2), doctor count (23), toolset count (17), documented config keys.

### Known CI flake, unsolved
apps/cli/src/repl/__tests__/approvals.restart.test.ts: the Bun child (`approval-restart-runner.ts
resume`) dies with "Cannot find module './internal/class' from packages/trent-core/src/store/
generated/client.ts" on some runs (7eb7502, a23efa5, 5989ac8), always green on rerun, and it
happened inside the serial (exclusive) vitest project, so the concurrent-Bun theory (68894ea) is
wrong. Next: find what rewrites store/generated during the run (the parallel project runs beside
the exclusive one), or give the child its own generated client copy.

### Bobby's decisions and steps (unchanged)
Default branch / tag v1.0.0 / repo rename / topics / private vulnerability reporting / platform
applications. NEW: the app's own embedding calls (apps/web/lib/wiki-embeddings.ts,
semantic-router.ts) need a one-line gate each to stop 404s on a local runtime and to stop sending
the objective to api.openai.com under a hosted key; an apps/web edit outside the two granted
exceptions. Free-tier Gemini key: 20/day on gemini-3.6-flash, per-minute 429s.

### What comes next, in order
Land S2+H3 (if not yet), H5, L1, S3, P3 (each after its agent's log exists). Then S4: docs/solo.md
final, README rows for solo and local, the live proof on this machine's qwen3.5:9b in solo mode
with constrained output (one run at a time; the machine swapped under concurrent Ollama calls),
the fleet-vs-solo cost table. Then the nightly local smoke (L2 owner's item), then a full clean-HEAD
suite and a CI check, then the daily sweep continues from here.
