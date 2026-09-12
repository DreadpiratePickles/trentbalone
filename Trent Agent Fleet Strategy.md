# Trent Agent Fleet Strategy: Taking a Bleeding-Edge Platform to Production

**Prepared for:** Crodie Tv / DreadpiratePickles  
**Date:** September 2026  
**Repository:** [github.com/DreadpiratePickles/trent](https://github.com/DreadpiratePickles/trent) (commit `bcb8180`)

---

## Executive Summary

After deep inspection of Trent's codebase (commit `bcb8180`), the source tree shows a platform with strong foundations across most 2026 bleeding-edge patterns. What remains is not architectural invention but **productionization, protocol adoption, operational maturity, and deployment hardening**.

### What Trent Already Has (Verified from Source)

| Capability | Trent Implementation | Assessment |
|---|---|---|
| **Multi-provider model gateway** | [`lib/model-gateway.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/model-gateway.ts) — 5 providers (OpenAI, Anthropic, Google, Mistral, OpenRouter), tier-based routing (haiku/sonnet/opus), task tiers (triage/standard/synthesis), reversibility levels, quality policies, fallback chains, per-call cost tracking, semantic cache key | Domain-specific alternative to LiteLLM with richer routing logic |
| **MCP marketplace** | [`lib/mcp-connector-catalog.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/mcp-connector-catalog.ts) — Connector gallery with official/community/self-hosted sources, trust scores, risk tiers, policy classes, approval policies, transport types (HTTP/SSE/stdio) | Strong MCP integration with marketplace patterns |
| **Self-improvement loop** | 4-phase loop: Trace Store ([`lib/trace-store.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/trace-store.ts)) → Eval Gate ([`lib/eval-gate.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/eval-gate.ts)) → Skill Foundry ([`lib/skill-foundry.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/skill-foundry.ts)) → GEPA evolutionary prompt optimization ([`lib/gepa.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/gepa.ts)) | Frontier pattern — most platforms don't have this |
| **Agent marketplace** | [`lib/agent-marketplace.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/agent-marketplace.ts) — 164 specialist agents across 13 categories, free/paid tiers, Stripe billing, pack pricing, entitlements | Comprehensive agent catalog with billing |
| **Eval harness** | [`lib/eval-harness.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/eval-harness.ts) — Multiple grader types (contains, tool_call, state_check, llm_rubric), fixture-based scoring, failure clustering | Strong eval foundation |
| **Golden trace capture** | [`lib/orchestration-golden-capture.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/orchestration-golden-capture.ts) — Captures failed runs as golden traces with promote/list/sanitize functions | Golden trace pipeline exists |
| **Heartbeat autonomy** | [`lib/heartbeat.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/heartbeat.ts) — Inspects company state, decides autonomous action, kicks off orchestrated runs, runs self-improvement sweep, adds CEO autopilot updates, autoresearch feature flag | Strong design, needs production wiring |
| **Durable execution** | [`lib/orchestrator-run-worker.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/orchestrator-run-worker.ts) — Hydration/resume after approval, workbench checkpoints, orchestrator caching | Partial — needs process-restart recovery |
| **Skill health monitoring** | [`lib/skill-health.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/skill-health.ts) — Degradation detection, cascade to dependent skills; [`lib/tool-health.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/tool-health.ts) — tool failure cascading | Strong monitoring foundation |
| **Smart cache** | [`lib/ai-proxy/smart-cache.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/ai-proxy/smart-cache.ts) — Semantic cache with `semanticCacheKey` from model gateway, in-memory Map-based | Pattern exists, needs durable backing |
| **Readiness controls** | [`lib/readiness-controls.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/readiness-controls.ts) — Comprehensive readiness framework with security/privacy/testing/reliability/governance/architecture categories, multi-tenancy isolation, PII handling, data retention | Strong governance framework |
| **Audit & governance** | SHA-256 hash chain, approval gates, kill switch, per-agent budgets, reversibility matrix per agent | Strong governance foundation |
| **Agent traces** | [`lib/trace-store.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/trace-store.ts) — Per-step traces with tool calls, costs, critique verdicts, human corrections, skill-applied signals | Strong trace model, no external OTel export |
| **Orchestrator** | [`lib/orchestrator.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/orchestrator.ts) — Planner → DAG → Specialists → Critic → Consolidator, with replanning, escalation, concurrency control, delegation decisions | Comparable to LangGraph state graph pattern |

### What's Actually Missing

| Gap | Priority | Details |
|---|---|---|
| **A2A protocol** | High | No agent-to-agent communication protocol — agents can't discover or delegate to external agents |
| **External observability integration** | High | Has internal trace store but no OpenTelemetry export to Langfuse/LangSmith/Phoenix |
| **Production heartbeat wiring** | High | Code exists but cron validation and overnight autonomy not proven |
| **Provisioning validation** | Medium | GitHub→Neon→Vercel code exists but unvalidated against real accounts |
| **Worker deployment architecture** | High | Long-running agent loops need dedicated worker infrastructure, not serverless |
| **Fleet lifecycle management** | Medium | No versioned agent definitions with rollout/canary/rollback |
| **Operations & SLOs** | Medium | No defined success rates, latency budgets, or operational review cadence |
| **AutoGen integration** | Medium | Previously discussed as a goal — note: AutoGen is now in maintenance mode; Microsoft Agent Framework (MAF) 1.0 is the successor, GA April 2, 2026 ([Microsoft](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/)) |
| **Idempotency & side-effect safety** | High | No idempotency keys, transactional outbox, or dead-letter queues for irreversible external actions |
| **Multi-tenant isolation hardening** | Medium | Readiness controls identify this as a concern — needs enforcement verification |
| **Trace privacy & redaction** | Medium | No PII/secret redaction before external observability export |

---

## 1. The 2026 Agent Landscape (Context for Trent)

### 1.1 Frameworks

The major frameworks stabilized in 2026. LangChain/LangGraph hit 1.0 with a no-breaking-changes-until-2.0 commitment ([LangChain](https://www.langchain.com/blog/langchain-langgraph-1dot0)). Microsoft collapsed AutoGen + Semantic Kernel into **Microsoft Agent Framework (MAF) 1.0** (GA April 2, 2026) — AutoGen is now in community maintenance mode, bug/security fixes only ([Microsoft](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/), [microsoft/autogen](https://github.com/microsoft/autogen)). Google shipped ADK 2.0 with a graph-based execution engine across Python, Go, and TypeScript ([adk.dev/2.0](https://adk.dev/2.0/)).

**The most important framing shift:** in 2024-25 the question was "which orchestration framework?" In 2026 the question is "what does my harness own, what does my runtime own, and where does state live?" Anthropic articulates this as a Session / Harness / Sandbox decomposition where each can be swapped independently ([Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents)).

Trent's custom TypeScript orchestrator already implements an advanced pattern — a DAG-based pipeline with planner, specialists, critic, and consolidator. The question is not whether to replace it, but whether to selectively adopt framework primitives.

| Framework | Trent Relevance |
|---|---|
| **LangGraph** | Trent's orchestrator follows a similar state graph pattern. Could adopt PostgresSaver for checkpointing if custom checkpointing becomes complex |
| **Claude Agent SDK** | Relevant for subagent management if deepening Anthropic integration. Supports per-subagent model selection, tool restrictions, depth/concurrency limits, spend caps ([Claude Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/subagents)). Trent already implements these concepts natively |
| **OpenAI Agents SDK** (April 2026) | Native sandbox execution with Manifest abstraction, durable execution with snapshotting/rehydration, supports E2B/Daytona/Modal/Cloudflare/Vercel ([OpenAI](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)). Trent already supports E2B and Daytona |
| **Microsoft Agent Framework (MAF)** | Successor to AutoGen. 1.0 GA April 2, 2026. Enterprise-grade multi-agent orchestration, multi-provider, A2A + MCP interoperability. .NET and Python only — no TypeScript. Relevant if exploring .NET/Python sidecar executors ([Microsoft](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/)) |
| **AutoGen v0.4** | **Maintenance mode** — bug/security fixes only, no new features. Previously discussed as a goal for Trent. MAF is the successor. If still desired, use as an alternative executor for specific mission types, not as a replacement for the custom orchestrator ([microsoft/autogen](https://github.com/microsoft/autogen)) |
| **Vercel AI SDK 6** | TypeScript-native, 20M+ monthly downloads. `Agent`/`ToolLoopAgent`, tool-execution approval, full MCP (OAuth, resources, prompts, elicitation). Backwards compatible. Could serve as the agent loop primitive for new agent types ([Vercel](https://vercel.com/blog/ai-sdk-6)) |

### 1.2 The Two Protocols

**MCP (Model Context Protocol):** Trent already has a full MCP implementation — connector catalog, transport layer, tool adapter, policy engine, server with approval links and registry. **Critical update:** The MCP spec went through a major rewrite on July 28, 2026 — it is now a stateless request/response protocol. The `initialize`/`Mcp-Session-Id` exchange is retired, method and tool names travel in `Mcp-Method`/`Mcp-Name` HTTP headers for gateway routing, and client registration shifted from Dynamic Client Registration (DCR) to Client ID Metadata Documents (CIMD) ([MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)). **Trent's MCP implementation should be audited against the `2026-07-28` spec** — if it uses session-based transport, it needs migration. The deprecation window is 12 months.

The most important MCP production pattern of 2026 is **Code Mode** — instead of exposing N tools and burning context on schemas, expose one code-execution tool and let the model write code against a typed SDK. Cloudflare's implementation fits an entire API in ~1000 tokens ([Cloudflare](https://blog.cloudflare.com/code-mode-mcp/)). Anthropic ships the equivalent as programmatic tool calling ([Vercel](https://vercel.com/blog/ai-sdk-6)). This is the biggest single context-and-cost win available.

**A2A (Agent-to-Agent Protocol):** Google's open protocol launched April 2025, donated to the Linux Foundation June 2025. As of August 17, 2026, A2A joined the **Agentic AI Foundation (AAIF)** alongside MCP under one Linux Foundation body ([Forbes](https://www.forbes.com/sites/janakirammsv/2026/08/19/agent2agent-joins-the-agentic-ai-foundation-alongside-mcp/)). A2A v1.0 has shipped with 150+ supporting organizations, Signed Agent Cards with cryptographic identity verification, and cloud integration into Azure AI Foundry, Amazon Bedrock AgentCore, and Google Cloud ([Linux Foundation](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)).

**The honest read:** A2A "is not dead, but it is also not universally useful" — it earns its keep across organizational boundaries where agents span frameworks/vendors, and is overhead inside a single codebase ([glukhov.org](https://www.glukhov.org/ai-systems/comparisons/a2a-protocol-2026-adoption/)). **Recommendation: use MCP for tools, A2A for cross-org delegation only.**

**This is Trent's biggest interoperability gap.** Trent's 164 agents communicate through the internal orchestrator DAG but cannot be discovered by or delegate to external agents. A2A would make Trent an interoperable node in the cross-organizational agent web — but should be feature-flagged and experimental until production adoption is verified.

### 1.3 Observability Standardization

Observability consolidated on OpenTelemetry `gen_ai.*` semantic conventions. **Langfuse v4** shipped August 17, 2026, rebuilt around OpenTelemetry with 10x faster dashboards, TypeScript code evaluators, and Monitors that export to Slack/webhooks/GitHub Actions. Langfuse Cloud goes v4-only November 16, 2026 — JS/TS SDK must be ≥5.4.0 ([Langfuse](https://langfuse.com/changelog/2026-08-17-langfuse-v4)). Other platforms include LangSmith (LangChain stack), Arize Phoenix, Braintrust, and Helicone ([Reactify Solutions](https://www.reactify-solutions.com/articles/agent-evaluation-observability-2026)).

Trent has its own trace store ([`lib/trace-store.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/trace-store.ts)) which is well-designed for the self-improvement loop. But it's siloed — there's no OpenTelemetry export. Adding OTel export would let Trent traces flow into Langfuse or any other platform without changing the internal trace store.

### 1.4 Production Reference Architecture

The 2026 production reference stack has six layers ([Alice Labs](https://alicelabs.ai/en/insights/production-ai-agents-deployment-guide-2026)):

| Layer | Responsibility | Trent Status |
|---|---|---|
| Model provider | Reasoning and tool-use | Done — 5 providers |
| Agent framework | Agent loop, tools, subagents, state graph | Done — custom orchestrator |
| Durable state | Checkpointer and pub/sub | Partial — run worker hydration exists, needs process-restart recovery |
| Tool sandbox | Isolate tool execution | Done — E2B, Daytona, mock_local |
| LLM gateway | Routing, caching, cost caps, audit | Done — model-gateway.ts with semantic cache |
| Observability | Traces, metrics, evaluations | Partial — internal trace store, no OTel export |

Trent has strong foundations in 5 of 6 layers. The remaining work is finishing durable state recovery, adding OTel export, and productionizing the heartbeat.

---

## 2. Strategic Roadmap: Three Phases

### Phase 1: Productionization (Weeks 1-6)

**Goal:** Wire the unfinished surfaces and complete the deployment architecture.

#### 2.1 Deploy Long-Running Workers

Trent's Vercel config shows `maxDuration: 300` for the orchestration stream route and `maxDuration: 60` for heartbeat sweep. Vercel serverless functions have hard timeout limits. Long-running agent loops — orchestration runs, heartbeat sweeps, self-improvement sweeps, GEPA evolution — must run in dedicated worker processes, not serverless request handlers.

**Action:** Deploy Trent's BullMQ worker (`npm run worker` → [`lib/worker.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/worker.ts)) as a persistent container process.

Architecture:
```
Vercel (Next.js API routes)
  ├── Short requests (< 60s): approve, cancel, list, health
  ├── Stream route (< 300s): SSE timeline proxy
  └── Enqueue → Redis/BullMQ
           │
Worker Container (persistent)
  ├── Orchestration run worker (hydrate → execute → resume)
  ├── Heartbeat sweep worker
  ├── Self-improvement sweep worker
  ├── GEPA evolution worker
  └── Agent mission executor
```

Deployment options:
- **Railway/Render:** Easiest — deploy the worker as a separate service, connect to the same Redis/Postgres
- **Kubernetes:** Most robust — worker as a Deployment with HPA, separate from the Next.js app
- **Vercel Cron + external worker:** Use Vercel Cron to trigger, but run the actual work in an external worker

The Claude Agent SDK's subprocess model also belongs in worker infrastructure, not edge/serverless — it spawns a CLI process which requires persistent compute ([Kyle Redelinghuys](https://www.ksred.com/the-claude-agent-sdk-what-it-is-and-why-its-worth-understanding/)).

#### 2.2 Complete Durable Execution

Trent has `hydrateOrchestrationRun` and `resumeOrchestrationAfterApproval` in [`lib/orchestrator-run-worker.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/orchestrator-run-worker.ts), plus workbench checkpoints in Prisma. The gap is in surviving full process restarts mid-run.

**Action:** Add a process-startup recovery routine.

Two approaches:
1. **Custom:** Store orchestrator run state in Postgres. On worker startup, query incomplete runs and resume from the last checkpoint. Add a `worker_lease` column to track ownership. This fits Trent's existing architecture.
2. **Vercel Workflow SDK** (`workflow@4.8.x`): GA since April 2026, native to Next.js. `withWorkflow` from `workflow/next` makes TypeScript functions durable — persists progress, retries failed steps, suspends without consuming compute. AI SDK 6 integration turns agents into "durable, resumable workflows where each tool execution becomes a retryable, observable step" ([vercel/workflow](https://github.com/vercel/workflow), [Vercel](https://vercel.com/blog/ai-sdk-6)). This is the natural fit for Trent's Next.js stack.

Recommendation: Evaluate Vercel Workflow SDK for new agent types. For existing orchestrator runs, implement custom lease-based recovery first (fits the existing architecture, no new dependency). The OpenAI Agents SDK uses the same pattern: "When the agent's state is externalized, losing a sandbox container does not mean losing the run" ([OpenAI](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)).

#### 2.3 Wire the Heartbeat to Production Cron

Trent's heartbeat ([`lib/heartbeat.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/heartbeat.ts)) is fully designed — it inspects company state, decides autonomous action, kicks off orchestrated runs, runs the self-improvement sweep, and adds CEO autopilot updates. The Vercel cron config exists (`/api/heartbeat/sweep` every 3 hours, `/api/jobs/scheduler/sweep` every 15 minutes).

**Action:** Complete production wiring.

1. Set `CRON_SECRET` for authentication on the sweep endpoints
2. Deploy the worker container (Phase 2.1) so the heartbeat's long-running work doesn't hit Vercel timeouts
3. Make the heartbeat route enqueue work to BullMQ rather than executing inline
4. Test unattended overnight autonomy in staging:
   - Set `AUTORESEARCH_ENABLED=1` to enable the autoresearch sweep
   - Verify CEO autopilot messages appear in the morning
   - Verify self-improvement sweep runs (skills distilled, GEPA passes)
5. Define and enforce SLOs (see Phase 3)

#### 2.4 Validate Provisioning

Trent's provisioning code (GitHub → Neon → Vercel) exists with unit tests but is unvalidated against real accounts.

**Action:** End-to-end validation.

1. Set up a GitHub App (not PAT) for provisioning — scoped permissions, more secure
2. Test the full flow against staging accounts: create repo → provision Neon database → deploy to Vercel
3. Add the remaining provisioning targets: R2, DNS, Sentry, Render, Expo
4. Make provisioning an agent mission type — the Engineer agent can provision new projects autonomously with approval gates
5. Add provisioning validation to the preflight suite (`npm run preflight:perfection`)

#### 2.5 Add Idempotency & Side-Effect Safety

Trent performs irreversible external actions: GitHub PRs, Neon database creation, Vercel deploys, Stripe payments, social media posts, ad campaigns. Without idempotency guarantees, worker crashes and retries can duplicate these actions.

**Action:** Add idempotency infrastructure.

1. **Idempotency keys:** Every external action (provisioning, ad spend, social post, payment) should accept an idempotency key. Store the key + result in Postgres. On retry, return the stored result instead of re-executing.
2. **Transactional outbox:** Use a transactional outbox pattern — write the intended external action to an `outbox` table in the same DB transaction as the state change. A separate worker reads the outbox and executes the action, marking it as sent. This guarantees at-least-once delivery without losing actions on crash.
3. **Dead-letter queue:** For actions that fail repeatedly, move them to a dead-letter queue with alerting. Don't retry infinitely.
4. **Retry limits:** Enforce max retry counts per action type. Irreversible actions (payments, social posts) should have retry=1; reversible actions (GitHub PRs) can have higher limits.
5. **Lease-based execution:** Extend the worker lease from Phase 2.2 to cover external actions — if a worker dies mid-action, another worker can pick up the lease after the timeout.

This is more important than rollback because retries can duplicate irreversible actions that rollback cannot undo.

---

### Phase 2: Interoperability & Observability (Weeks 7-12)

**Goal:** Make Trent's agents interoperable with the external agent ecosystem and add external observability.

#### 3.1 Implement A2A Protocol Support

This is Trent's biggest strategic gap. A2A would enable:
- Trent's 164 specialist agents to be discovered by external agents via Agent Cards
- External agents (Salesforce, ServiceNow, SAP, custom) to delegate tasks to Trent's specialists
- Trent's orchestrator to discover and delegate to external A2A-compatible agents
- Long-running task coordination with real-time status updates

**Action:** Implement A2A as a feature-flagged adapter layer.

Implementation plan:

1. **Agent Cards:** Generate JSON Agent Cards for each of Trent's 164 specialist agents (or at minimum, the 9 core roles). Each card advertises capabilities, supported tools (via MCP), supported modalities, and authentication requirements. Store in a new `lib/a2a/agent-cards.ts` module.

2. **A2A Server:** Expose Trent's agents as A2A remote agents over HTTP/SSE/JSON-RPC. This means any A2A-compatible client can:
   - Discover Trent agents via their Agent Cards
   - Submit tasks to Trent agents
   - Receive real-time status updates over SSE
   - Receive artifacts when tasks complete

3. **A2A Client:** Enable Trent's orchestrator to discover and delegate to external A2A agents. Add a new delegation path in `lib/orchestrator-delegation.ts` that can route subtasks to external A2A agents when they're better suited than internal specialists.

4. **Task lifecycle mapping:** Map Trent's run states to the A2A task lifecycle once verified against the current A2A specification. Trent's states are: `planning → running → awaiting_approval → completed → failed`. Feature-flag this mapping and verify against the A2A spec before production use.

5. **Authentication:** Implement enterprise-grade auth with parity to OpenAPI authentication schemes, as the A2A spec requires ([Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)).

6. **Feature flag:** Gate A2A behind an `A2A_ENABLED` flag initially — treat as experimental until you verify production adoption and spec stability.

**Strategic positioning:** A2A support makes Trent not just an agent platform but an interoperable agent platform that can participate in cross-organizational agent workflows. This is a meaningful differentiator as the A2A ecosystem matures.

#### 3.2 Add OpenTelemetry Export

Trent's internal trace store ([`lib/trace-store.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/trace-store.ts)) is well-designed for the self-improvement loop. But it's siloed — there's no way to export traces to external observability platforms for debugging, alerting, or cross-system analysis.

**Action:** Add OTel GenAI export alongside the internal trace store.

1. Add `@opentelemetry/api` and `@opentelemetry/sdk-node` to dependencies
2. Instrument [`lib/ai-client.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/ai-client.ts) to emit `invoke_agent` spans (top-level), `chat` spans (per LLM call), and `execute_tool` spans (per tool invocation), following the OTel GenAI semantic conventions ([Reactify Solutions](https://www.reactify-solutions.com/articles/agent-evaluation-observability-2026))
3. Instrument [`lib/orchestrator.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/orchestrator.ts) to trace the full pipeline: planning → DAG → specialists → critic → consolidator
4. Tag every span with `company_id`, `run_id`, `agent_role`, `task_type` for filtering
5. Export to a self-hosted Langfuse instance (open source, OTel-native, no per-trace pricing) or alternatively to LangSmith/Phoenix/Braintrust

**Trace privacy and redaction (critical before enabling export):**

Before any trace leaves Trent, implement redaction:
- Strip API keys, OAuth tokens, and secrets from tool call inputs/outputs
- Redact PII (emails, phone numbers, addresses) using configurable patterns
- Implement sampling: export 100% of error traces, 10% of success traces (tunable)
- Set retention policies: 30-day hot, 90-day cold storage
- Allow per-company opt-out of trace export for privacy-sensitive tenants
- Self-host Langfuse to keep traces within your infrastructure

This does NOT replace the internal trace store — the internal store feeds the self-improvement loop. OTel export is additive: it gives you external observability, alerting, and the ability to share traces across platforms.

#### 3.3 AutoGen / MAF Integration (Previously Discussed)

Memory indicates a prior goal of integrating AutoGen as the agent runtime layer for Trent's 9-seat operating loop. **Critical update:** AutoGen is now in maintenance mode — Microsoft collapsed AutoGen + Semantic Kernel into Microsoft Agent Framework (MAF) 1.0, GA April 2, 2026 ([Microsoft](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/), [microsoft/autogen](https://github.com/microsoft/autogen)).

Trent's custom orchestrator now handles this role natively, so AutoGen/MAF integration should be selective rather than wholesale:

1. **Multi-agent conversations:** MAF's conversation-driven model is good for scenarios where agents need to debate or negotiate (e.g., CEO + Engineer + Finance discussing a strategic decision). Trent's DAG-based orchestrator is better for structured task pipelines but less natural for free-form multi-agent conversations.
2. **Integration approach:** Use MAF as an alternative executor for specific mission types — not as a replacement for the custom orchestrator. Add an `MAFExecutor` alongside the existing executor in [`lib/agent-mission-executor.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/agent-mission-executor.ts). Note: MAF is .NET and Python only — no TypeScript, so this would require a sidecar process.
3. **Evaluate against Trent's existing eval harness:** Run MAF-executed missions through [`lib/eval-harness.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/eval-harness.ts) and compare scores against the native executor. Only adopt where it meaningfully outperforms.
4. **Alternative:** Consider Vercel AI SDK 6's `ToolLoopAgent` as a TypeScript-native alternative for new agent types — it's the same vendor as Trent's framework and supports full MCP, tool-execution approval, and durable workflows ([Vercel](https://vercel.com/blog/ai-sdk-6)).

---

### Phase 3: Operations, Fleet Lifecycle & SLOs (Weeks 13-18)

**Goal:** Add the operational maturity that separates a platform from a product.

#### 4.1 Fleet Lifecycle Management (AgentSpec)

Trent has 164 agents in a catalog but lacks versioned agent definitions with lifecycle management. The 2026 best practice is to treat each agent like a microservice with a deployment lifecycle.

**Action:** Add an AgentSpec system.

Each agent definition should include:

| Field | Purpose |
|---|---|
| `version` | Semantic version for the agent definition |
| `role` | Agent role (CEO, Engineer, etc.) |
| `prompt` | System prompt (versioned, diffable) |
| `tools` | Allowed tool list (MCP servers + internal tools) |
| `modelPolicy` | Provider, tier, quality policy, fallback chain |
| `budgets` | Per-run token budget, per-day cost cap |
| `memoryScope` | What memory sources the agent reads/writes |
| `approvalPolicy` | What actions require human approval |
| `evalSuite` | Capability + regression test fixtures |
| `owner` | Human responsible for this agent |
| `rolloutStatus` | `draft → canary → live → deprecated` |

Implementation:
1. Store AgentSpecs as versioned records in Postgres (new `AgentSpecVersion` model)
2. Add a canary deployment path: new agent versions serve a percentage of traffic, with automatic rollback if eval scores drop below threshold
3. Add a rollback action: revert to previous agent version with one click, reversing any state changes via the audit log
4. Surface rollout status in the command console

#### 4.2 Multi-Tenant Isolation Hardening

Trent's readiness controls ([`lib/readiness-controls.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/readiness-controls.ts)) already identify multi-tenancy data isolation as a required control. With company-scoped memory, traces, MCP credentials, jobs, approvals, and marketplace billing, isolation must be enforced at every layer.

**Action:** Verify and harden multi-tenant isolation.

1. **Data isolation:** Ensure every database query is scoped by `companyId`. Add automated tests that verify no cross-company data leakage (Trent's test suite should include tenant isolation tests).
2. **MCP credential isolation:** Verify MCP server credentials are encrypted per-company and never leaked across tenants ([`lib/mcp-store.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/mcp-store.ts)).
3. **Worker context isolation:** Ensure the worker process maintains company context throughout a run — no global state that could leak between concurrent runs from different companies.
4. **Trace isolation:** Ensure the internal trace store and OTel export both filter by `companyId` — no cross-company trace visibility.
5. **Budget isolation:** Verify per-company budget caps are enforced independently — one company's heavy usage should not affect another.
6. **Approval queue isolation:** Verify approval queues are scoped per-company — no cross-tenant approval visibility.

#### 4.3 MCP Supply-Chain Controls

Trent's MCP connector catalog already has trust scores and risk tiers. These should be actively enforced.

**Action:** Enforce MCP supply-chain controls.

1. **Minimum trust score:** Enforce a minimum trust score for production MCP servers. Community servers below the threshold should require explicit approval before use.
2. **Pin server versions:** Pin MCP server versions to prevent silent breaking changes. Track version drift and alert when a pinned version is deprecated.
3. **Restrict transport types:** In production, restrict to HTTP/SSE transports. Stdio/local servers should only be allowed in development.
4. **Sandbox MCP execution:** Ensure MCP tool execution happens in sandboxed environments (E2B/Daytona), not on the host.
5. **Egress control:** Restrict outbound network access from MCP tool execution to known-good domains. Block data exfiltration paths.
6. **Provenance tracking:** Require provenance metadata for all MCP connectors. Track who added/modified each connector and when.

#### 4.4 Model Gateway Hardening

Trent's model gateway ([`lib/model-gateway.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/model-gateway.ts)) is already sophisticated — 5 providers, tier-based routing, task tiers, reversibility levels, quality policies, fallback chains, per-call cost tracking, and a semantic cache ([`lib/ai-proxy/smart-cache.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/ai-proxy/smart-cache.ts)).

**The highest-ROI single change is prompt caching, and it has peer-reviewed numbers.** A PwC study found prompt caching reduces API costs by 41-80% and improves time-to-first-token by 13-31% across providers ([arXiv:2601.06007](https://arxiv.org/html/2601.06007v2)). The actionable finding is cache-block discipline: place stable system prompts, tool schemas, and skills at the front; put dynamic content at the end; never inject timestamps or per-request IDs into the cached prefix.

Provider mechanics differ and matter for architecture: OpenAI caches automatically above a token threshold with exact-prefix matching; Anthropic uses developer-controlled explicit cache breakpoints with configurable TTL; Google offers implicit plus explicit context caching ([arXiv:2601.06007](https://arxiv.org/html/2601.06007v2)).

**Code Mode is the biggest context-economy win.** Instead of exposing 40 tool schemas that burn context on every turn, expose one code-execution tool and let the model write code against a typed SDK. Cloudflare's implementation fits an entire API in ~1000 tokens ([Cloudflare](https://blog.cloudflare.com/code-mode-mcp/)). Anthropic ships the equivalent as programmatic tool calling ([Vercel](https://vercel.com/blog/ai-sdk-6)). Trent's 164-agent catalog with per-agent designed tools is a prime candidate for Code Mode refactoring.

**Model-specific breaking changes to watch:**
- `tool_choice: "any"` and `"tool"` return a 400 on Claude Fable 5.1 / Mythos 5.1. If Trent's code force-calls a tool, migrate to strict tool use / structured outputs before switching models ([Anthropic release notes](https://docs.anthropic.com/en/release-notes/api))
- Thinking blocks are model-bound: replaying a thinking block after changing the system prompt, tools, or an earlier message returns a 400 for accounts created on/after Aug 31, 2026. Multi-model agent loops that shuttle history between Claude versions will break unless you handle `input_transformations` ([Anthropic release notes](https://docs.anthropic.com/en/release-notes/api))
- Claude Fable 5.1's cache reads are $0.25/MTok (0.025x base input vs 0.1x on other Claude models). For long-running agents that re-read a large stable prefix, Fable 5.1 can be cheaper per turn than Opus 5 despite 2x higher headline input price ([Anthropic](https://docs.anthropic.com/en/release-notes/api))
- OpenAI charges a long-context tier: above the short-context threshold, prices double. Context bloat is now a step-function cost ([OpenAI pricing](https://developers.openai.com/api/docs/pricing))

**Refinements to consider:**

1. **Durable cache backing:** Trent's smart cache is in-memory only (Map-based). Back it with Redis so cache survives process restarts and is shared across worker instances.
2. **Pre-call budget enforcement:** Trent tracks costs per-call, but verify that budget enforcement happens BEFORE the API call, not just after. Block calls that would exceed the per-agent or per-company budget.
3. **Provider health checks / circuit breakers:** Add circuit breaker logic — if a provider returns errors above a threshold, automatically failover to the next in the fallback chain. Trent has fallback chains but should verify they include health-based switching.
4. **Batch processing:** For non-real-time tasks (nightly heartbeat sweeps, GEPA evolution, autoresearch), use batch APIs which offer ~50% discounts.
5. **Model deprecation monitoring:** Track when models are deprecated by providers. Trent's `MODELS` registry should have a deprecation status field.
6. **Cache-first prompt design:** Audit all agent system prompts for cache stability. Any dynamic content (timestamps, per-request IDs, variable prefixes) in the cached portion destroys the cache hit. This single discipline is what turns the 41-80% caching saving on or off.

#### 4.5 Operational Cadence & SLOs

**Action:** Define and enforce operational SLOs.

| SLO | Initial Target (tune after baseline) | Measurement |
|---|---|---|
| Run success rate | > 90% | Completed runs / total runs per agent role |
| Tool error rate | < 5% | Failed tool calls / total tool calls per agent |
| Approval rejection rate | < 20% | Rejected approvals / total approvals |
| P95 latency (triage-tier task) | < 30s | Time from run start to completion |
| P95 latency (standard-tier task) | < 2min | Time from run start to completion |
| P95 latency (synthesis-tier task) | < 10min | Time from run start to completion |
| P95 latency (long-running research/autonomy mission) | < 4hr | Time from run start to completion (separate SLO from standard tasks) |
| Budget burn rate | < 100% of cap | Actual spend / budget cap per company per day |
| Self-improvement skill quality | > 0.8 | Average eval score of promoted skills |
| GEPA improvement rate | > 0 | Weekly GEPA best score trend |

Note: These are initial pilot targets to calibrate after collecting baseline data. The long-running research/autonomy SLO is separate from standard task SLOs to avoid conflicts.

**Weekly operational review:**
1. Pull Langfuse/OTel traces for the week — review failure clusters
2. Check self-improvement sweep results — skills distilled, promoted, GEPA passes
3. Review degraded skills and tools from [`lib/skill-health.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/skill-health.ts) and [`lib/tool-health.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/tool-health.ts)
4. Review budget burn across companies — adjust model routing if over budget
5. Run red-team tests: prompt injection, budget bypass, approval gate bypass, audit log tampering
6. Review agent version rollout status — promote canaries, rollback regressions

**Monthly operational review:**
1. Model routing audit — are tasks being routed to the right tier?
2. Credential rotation — rotate API keys, MCP tokens (see below for `SECRET_ENCRYPTION_KEY`)
3. Eval suite expansion — add new golden traces from interesting production runs
4. Agent catalog review — retire unused agents, add new specialists based on usage patterns

**Credential rotation note:** Rotating `SECRET_ENCRYPTION_KEY` is not a simple key swap — it requires re-encrypting all stored credentials. Use envelope encryption with a KMS, key IDs, staged rotation (new key encrypts new writes, old key still decrypts), and a re-encryption migration job that gradually re-encrypts all stored secrets. Never rotate the encryption key without a re-encryption plan.

#### 4.6 CI/CD Pipeline for Agents

Trent already has an impressive preflight suite (`npm run preflight:perfection`) that runs typecheck, build, tests, CI truth, security, orchestration proofs, workbench proofs, MCP proofs, acceptance cycles, and compounding proofs.

**Action:** Extend the preflight with agent-specific gates.

1. **Eval gate:** Run the eval harness against all live agent versions before deployment. Block if any agent's score drops below its baseline.
2. **Trace regression:** Replay golden traces through the new code and compare outputs. Flag any drift. Trent already has golden capture infrastructure ([`lib/orchestration-golden-capture.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/orchestration-golden-capture.ts)).
3. **Budget impact check:** Run a sample of golden traces and verify cost hasn't increased beyond a threshold.
4. **Safety gate:** Run automated prompt injection tests against each agent role.
5. **Canary promotion:** After preflight passes, deploy to canary (5% traffic), monitor for 24 hours, auto-promote to live if SLOs hold.

---

## 5. Governance & Safety (Already Strong — Hardening)

Trent's governance is already strong: SHA-256 audit chain, approval gates, kill switch, per-agent budgets, reversibility matrix per agent, MCP policy classes, trust scores, risk tiers, and a comprehensive readiness controls framework ([`lib/readiness-controls.ts`](https://github.com/DreadpiratePickles/trent/blob/bcb8180/lib/readiness-controls.ts)).

**Additional hardening:**

1. **Prompt injection defense:** Design assuming prompt-injection and exfiltration attempts ([OpenAI](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)). Separate the harness from compute to keep credentials out of environments where model-generated code executes. Trent's sandbox model (E2B/Daytona/mock_local) already does this — verify that API keys are never available inside sandbox environments.

2. **Subagent depth/concurrency limits:** Claude Agent SDK enforces max 3 layers of subagent depth, max 20 concurrent subagents, and a spend cap per query ([Claude Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/subagents)). Trent has `ORC_MAX_CONCURRENCY` (default 4) — consider whether this is sufficient for production workloads, and add depth limiting if not present.

3. **Red-teaming automation:** Add automated red-team tests to the weekly operational review:
   - Prompt injection attempts against each agent role
   - Budget bypass attempts
   - Approval gate bypass attempts
   - Audit log tampering attempts
   - MCP tool abuse attempts

---

## 6. Technology Stack (Current State Assessment)

### Keep (Strong Foundations)

| Component | What Trent Uses | Assessment |
|---|---|---|
| Framework | Next.js 15 + TypeScript | Modern, type-safe, Vercel-native |
| Database | PostgreSQL + Prisma + pgvector | Production-grade, vector storage |
| Queue | BullMQ + Redis | Durable, battle-tested |
| Auth | NextAuth v5 | Standard, secure |
| Sandbox | E2B + Daytona + mock_local | Matches OpenAI Agents SDK providers |
| Model gateway | Custom 5-provider gateway | Domain-specific routing, semantic cache |
| MCP | Full connector catalog + marketplace | Strong MCP integration |
| Self-improvement | Trace Store → Eval Gate → Skill Foundry → GEPA | Frontier pattern |
| Audit | SHA-256 hash chain | Strong governance |
| Readiness controls | Comprehensive framework | Security/privacy/reliability/governance |
| Agent catalog | 164 specialists, 13 categories, marketplace | Comprehensive |
| Golden traces | Orchestration golden capture | Eval regression pipeline |

### Add

| Component | Purpose | Integration Point |
|---|---|---|
| OTel export | External observability | Instrument `lib/ai-client.ts` and `lib/orchestrator.ts` |
| Langfuse (self-hosted) | Trace visualization, alerting | Receives OTel export |
| A2A adapter | Agent-to-agent interoperability | New `lib/a2a/` module (feature-flagged) |
| Worker container | Long-running process execution | Deploy `lib/worker.ts` as persistent service |
| AgentSpec system | Versioned agent definitions with lifecycle | New Prisma model + UI |
| Idempotency/outbox | Side-effect safety for external actions | New `lib/idempotency.ts` + outbox table |
| Durable cache backing | Smart cache survives restarts | Back `smart-cache.ts` with Redis |

### Consider (Optional)

| Component | When | Why |
|---|---|---|
| AutoGen (selective) | If multi-agent conversation patterns emerge | Better for debate/negotiation than DAG pipelines |
| LangGraph PostgresSaver | If custom checkpointing becomes complex | Battle-tested production checkpointer |
| Letta | If self-improvement needs deeper memory | Reported 83.2% LongMemEval, OS-tiered memory ([NiteAgent](https://niteagent.com/blog/ai-agent-memory-comparison-2026/)) |
| Zep/Graphiti | If temporal reasoning becomes important | Temporal knowledge graphs ([NiteAgent](https://niteagent.com/blog/ai-agent-memory-comparison-2026/)) |

---

## 7. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Worker process dies mid-run | Medium | High | Durable execution with lease + recovery (Phase 2.2) |
| Duplicated irreversible actions on retry | Medium | Critical | Idempotency keys + transactional outbox (Phase 2.5) |
| A2A spec still maturing | Medium | Low | Feature flag, experimental adapter, don't depend on it for core |
| MCP servers unreliable | High | Medium | Trent has trust scores and risk tiers — enforce minimum trust score |
| Self-improvement loop degrades agent quality | Low | High | Eval gate prevents unvalidated skill promotion. Add canary + rollback |
| Cost runaway from 164-agent fleet | Medium | High | Model gateway has per-call cost tracking. Add per-company daily caps |
| Model provider outage | Low | Medium | Model gateway has fallback chains across 5 providers |
| Prompt injection in production | Medium | Critical | Sandbox isolation, architectural guardrails, weekly red-teaming |
| Trace data leakage via OTel export | Medium | High | Redaction, sampling, retention, per-company opt-out (Phase 3.2) |
| Cross-tenant data leakage | Low | Critical | Multi-tenant isolation hardening (Phase 4.2) |

---

## 8. Implementation Priority

```
Weeks 1-6:   [████████████████████] Phase 1 — Workers, durable execution, heartbeat, provisioning, idempotency
Weeks 7-12:  [████████████████████] Phase 2 — A2A protocol, OTel observability, AutoGen evaluation
Weeks 13-18: [████████████████████] Phase 3 — AgentSpec lifecycle, SLOs, CI/CD, operations
```

**If you do nothing else, do these three things first:**

1. **Deploy the worker as a persistent container** — Vercel serverless timeouts will kill long-running agent loops. This is the #1 production blocker.

2. **Wire the heartbeat to production cron** — Trent's heartbeat + self-improvement sweep is its killer feature. It's fully designed but not running in production. This is what makes Trent "wake up at night, do work, send you an update."

3. **Add idempotency for external actions** — Without this, a worker crash mid-provisioning or mid-payment can create duplicated irreversible actions that no audit log can undo.

These three changes move Trent from "advanced prototype" to "production agent fleet" according to the 2026 definition of production-readiness ([Alice Labs](https://alicelabs.ai/en/insights/production-ai-agents-deployment-guide-2026)).

---

## Key Sources

- [Alice Labs — Production AI Agents Deployment Guide 2026](https://alicelabs.ai/en/insights/production-ai-agents-deployment-guide-2026)
- [Reactify Solutions — Agent Evaluation and Observability in 2026](https://www.reactify-solutions.com/articles/agent-evaluation-observability-2026)
- [OpenAI — The Next Evolution of the Agents SDK (April 2026)](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)
- [Claude Agent SDK — Subagents Documentation](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Anthropic Engineering — Managed Agents](https://www.anthropic.com/engineering/managed-agents)
- [Kyle Redelinghuys — Claude Agent SDK: Subagents, Sessions and Why It's Worth It](https://www.ksred.com/the-claude-agent-sdk-what-it-is-and-why-its-worth-understanding/)
- [Google Developers Blog — Announcing A2A Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [Linux Foundation — A2A Surpasses 150 Organizations](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
- [Forbes — A2A Joins the Agentic AI Foundation](https://www.forbes.com/sites/janakirammsv/2026/08/19/agent2agent-joins-the-agentic-ai-foundation-alongside-mcp/)
- [MCP Blog — 2026-07-28 Stateless Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP Blog — 2026 Roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [Cloudflare — Code Mode MCP](https://blog.cloudflare.com/code-mode-mcp/)
- [LangChain — LangChain/LangGraph 1.0](https://www.langchain.com/blog/langchain-langgraph-1dot0)
- [Microsoft — MAF 1.0 GA](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/)
- [microsoft/autogen — Maintenance Mode](https://github.com/microsoft/autogen)
- [Google ADK 2.0](https://adk.dev/2.0/)
- [Vercel — AI SDK 6](https://vercel.com/blog/ai-sdk-6)
- [vercel/workflow — Workflow SDK](https://github.com/vercel/workflow)
- [Langfuse v4 Release](https://langfuse.com/changelog/2026-08-17-langfuse-v4)
- [Anthropic Release Notes — API](https://docs.anthropic.com/en/release-notes/api)
- [OpenAI Pricing](https://developers.openai.com/api/docs/pricing)
- [arXiv:2601.06007 — Prompt Caching for Long-Horizon Agentic Tasks](https://arxiv.org/html/2601.06007v2)
- [NiteAgent — Mem0 vs Zep vs LangMem vs Letta: Memory Showdown 2026](https://niteagent.com/blog/ai-agent-memory-comparison-2026/)
- [CrewAI — How to Build Agentic Systems](https://crewai.com/blog/how-to-build-agentic-systems-the-missing-architecture-for-production-ai-agents)
- [Kubernetes Blog — Agent Sandbox CRD](https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox/)
- [NIST — AI Agent Standards Initiative](https://www.nist.gov/artificial-intelligence/ai-agent-standards-initiative)
- [Trent GitHub Repository (commit bcb8180)](https://github.com/DreadpiratePickles/trent)
