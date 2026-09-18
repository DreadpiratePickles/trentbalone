# Fleet brain audit — nine seats, persistent memory, shared brain, self-improvement

Date: 2026-09-18. Branch `feature/trent-fleet-v2`. Read-only audit; no file outside this one was touched.

Vision under test: "nine role agents with well-defined roles, persistent memory, self-improving
agents, and a shared brain."

Method: `grep -n` / `sed -n` for every line number; tests were read, not trusted from comments.
Docs (`AGENTS.md`, `CONTEXT.md`, `README.md`, `fleet-memory/README.md`, `orchestrator-contract.md`,
`cs329a-applied.md`) were used as a map only and are contradicted below where the code disagrees.

Caveat on HEAD: commissioned against `0572c51`, but during the audit the tree moved to `4caa437` and
ten files under `apps/cli/` and `packages/trent-core/src/{fleet-memory,tools/memory}/` picked up
uncommitted edits. Another session is editing this repo concurrently, so line numbers in those files
may drift. Every citation was read during the audit window and spot-re-verified at the end.

---

## 1. The nine seats and roles

### 1.1 There are two different nine-seat rosters, and they disagree

| Roster | Where | Members |
|---|---|---|
| Execution roster (`AgentRole`) | `apps/web/lib/types.ts:48-57`; mirrored `apps/web/lib/seat-agent-loop.ts:205`, `packages/trent-core/src/orchestrator/seat-wiring.ts:17`, `packages/trent-core/src/traces/trace-store.ts:24-33` | ceo, engineer, growth, content, support, analyst, finance, escalation, **sales** |
| CLI fleet roster (`CORE_ROLES`) | `packages/trent-core/src/fleet/AgentInstaller.ts:52-129` | ceo, engineer, growth, content, support, analyst, finance, **browser** (`:111-118`), escalation |

There is no `browser` seat in the execution union (`grep -n '"browser"' apps/web/lib/types.ts` matches
only a cost category at `types.ts:540`). `trent fleet` therefore lists a seat — "Autonomous Web
Navigator" — that can never be assigned a step. `sales` is the inverse: executable, but invisible to
the CLI's fleet roster.

### 1.2 Only five of the nine seats can ever run a step

`apps/web/lib/orchestrator-runtime.ts:81-90`:

```
export const ACTIVE_SEATS = ["ceo", "engineer", "growth", "content", "support"] as const;
const SHELVED_SEAT_ROUTING = { analyst: "ceo", finance: "ceo", escalation: "ceo", sales: "growth" };
```

`toActiveSeat` is applied at the single plan chokepoint `normalizePlan` (`orchestrator-runtime.ts:414`,
comment at `:411-413` states the intent) and inside the planner-role normaliser (`:96`). Analyst,
finance, escalation and sales have full prompts, skills, tools, budgets, manifests and tests, and are
**unreachable**. This is the single largest gap against "nine role agents".

### 1.3 Per-seat definition sources

| Artefact | File:line |
|---|---|
| Seat list, `modelPolicy`, `permissions`, quality label | `apps/web/lib/agents.ts:4-77` |
| **System prompt text** (base + per-role `specifics`) | `apps/web/lib/agents.ts:88-185` (map at `:104-183`) |
| Slot labels | `apps/web/lib/agent-catalog.ts:1762-1772` (`AGENT_SLOTS`) |
| Mission / inputs / deliverables / success metrics | `apps/web/lib/agent-catalog.ts:1782-1846` (`SLOT_CONTRACTS`) |
| Tools, approval gates, `budgetCentsPerRun`, `maxRuntimeSeconds`, output contract, skills | `apps/web/lib/agent-catalog.ts:1977-2050` (`SLOT_ENVIRONMENTS`), instantiated `:2052-2062` |
| Second prompt layer: methodology, anti-patterns, tool contracts, context needs, memory plan, `modelTier`, `evalRubric` | `apps/web/lib/seat-manifest.ts:109-340` (`SEAT_MANIFESTS`), rendered `:359-380` |
| Per-seat skill slug lists | `apps/web/lib/agent-catalog.ts:1877-1967` |
| Assembly into `systemPrompt` / `dynamicPrompt` | `apps/web/lib/agent-runtime.ts:135-136` |

Budgets differ by seat: engineer 500c/900s (`agent-catalog.ts:1989-1990`), analyst 350c
(`:2021`), ceo/growth 250c (`:1981`, `:1997`), content 175c (`:2005`), support 150c (`:2013`),
finance 125c (`:2029`), escalation 75c (`:2037`), sales 225c (`:2045`).

### 1.4 Routing: planner LLM, then a regex coercion table

1. `launchOrchestration` enqueues a plan job; `apps/web/lib/orchestrator-run-worker.ts:47,51,55` dispatches `plan` / `execute_step` / `consolidate`.
2. Plan: `apps/web/lib/orchestrator-run-phases.ts:114-142` -> `generateOrchestrationPlan`, prompts at `orchestrator-runtime.ts:861-928`, planner model `:68`.
3. **Who chooses `agentRole`:** the planner LLM returns free text, which is coerced by a hardcoded regex cascade — `normalizePlannerAgentRole` (`orchestrator-runtime.ts:92-106`), terminal fallback `return normalized ? "ceo" : value` (`:105`). The planner is additionally pre-biased by a pure regex lookup `recommendSeatForObjective` (`apps/web/lib/agent-routing-context.ts:13+`) injected at `orchestrator-runtime.ts:864,884`.
4. Deterministic fallbacks with hardcoded roles: `:693-750`, `:752-800`, `:807-870`. Route repair when the planner returns CEO-only: `repairOrchestrationPlanRoutes` `:448-499`.
5. DAG scheduling: `apps/web/lib/orchestrator-run-queue.ts:21-32`.
6. Execute: `orchestrator-run-phases.ts:255-266` -> `executeStepWithRuntime` (`orchestrator-runtime.ts:1360`).
7. **Critic is not a seat:** a standalone LLM call on `CRITIC_MODEL`, "You are Trent's quality supervisor" (`orchestrator-runtime.ts:969-1005`, prompt `:978`). One retry `orchestrator-run-phases.ts:294`; verdict handling `apps/web/lib/orchestrator.ts:162-234`.
8. **Consolidator is not a seat either:** another standalone call on `SPECIALIST_MODEL` (`orchestrator-runtime.ts:1068-1097`).

### 1.5 Are the seats genuinely different capabilities?

Real differentiation (data-driven, enforced in code):

- Tool allowlists per seat, enforced by intersection at `apps/web/lib/seat-agent-loop.ts:212-217` and `apps/web/lib/semantic-router.ts:237-239`.
- Approval gates per seat: `approvalRequiredFor` (`agent-catalog.ts:1980,1988,1996,...`), enforced `seat-agent-loop.ts:344,424,528`.
- Memory namespace per seat: `company:{companyId}/agent:{role}` (`agent-catalog.ts:2056`).
- Context fetches gated on `getSeatManifest(role).contextNeeds` (`orchestrator-runtime.ts:1232-1253`).
- Tool-loop length differs for engineer and analyst only (`seat-agent-loop.ts:579-583`).
- Tests: `apps/web/lib/agent-runtime.test.ts:39` "builds default environments for every slot"; `apps/web/lib/seat-tool-contracts.test.ts:296` "every seat in AgentRole has a contract block", `:283` runtime tools equal the advertised contract set.

Where it collapses to one loop with a different prompt:

- **One executor.** `executeStepWithRuntime` (`orchestrator-runtime.ts:1360`) -> one `getAgentRuntime` (`:1374`) -> one `runSeatAgent` (`:1495`). The only role-dependent inputs are prompt strings, the tool array, an int budget, context needs, and `classification.type` (`:1424`).
- **Per-seat budget is advisory.** `budgetCents` is set on the subtask at `orchestrator-runtime.ts:1428` and is never compared to spend: `grep -n budget apps/web/lib/seat-agent-loop.ts` returns nothing. The seat loop accumulates `costCents` (`seat-agent-loop.ts:228`) and never caps it.
- **Model differentiation is two lines.** `apps/web/lib/model-gateway.ts:106-107`: finance/ceo forced opus, support+reversible+triage forced haiku; everything else sonnet (`:105`). `modelPolicy` in `agents.ts` and `AgentInstaller.ts` is never read by the runtime.
- **In the CLI even those two lines collapse.** `packages/trent-core/src/orchestrator/model-env.ts:69` writes the one configured model into FAST, DEFAULT and STRONG tier vars alike, so every seat resolves to the same model.
- **The CLI gives all nine seats identical tools.** `wireSeatTools` loops over `SEAT_ROLES` and upserts the *same* adapter list into every role's environment (`packages/trent-core/src/orchestrator/seat-wiring.ts:45-61`); `buildTrentTools` builds from global `config.toolsets`, with no seat parameter (`packages/trent-core/src/tools/index.ts:135-195`).
- `AgentInstaller` gives every core role the same two tools: `CORE_ROLE_TOOLS = [file_ops, terminal]` (`AgentInstaller.ts:45-48`, used `:213-227`).

### 1.6 Delegation and supervision

- `delegate_task` exists: `packages/trent-core/src/tools/delegate/index.ts:19-35`; port `orchestrator/delegate-port.ts`; real child runner `orchestrator/delegate-child.ts:114`. Bound only in the CLI (`apps/cli/src/runtime/headless.ts:18,193`); unbound it reports `not_available` (`delegate/index.ts:126`, proven `tools/tools-index.test.ts:22`). Caps `DELEGATE_MAX_CHILDREN` / `DELEGATE_MAX_DEPTH` (`orchestrator/index.ts:72`); tests `orchestrator/delegate-port.test.ts:80,94,110,127`; CLI end-to-end `apps/cli/src/repl/__tests__/delegate.repl.test.ts:135`.
- The web path uses a different mechanism: seats emit `workRequests` in their JSON output (`orchestrator-runtime.ts:1570-1585`) -> `buildDelegatedStepsForWorkRequests` (`orchestrator-run-phases.ts:410-425`, impl `apps/web/lib/orchestrator-delegation.ts:59+`), caps 6/run depth 2 (`orchestrator-delegation.ts:7-9`).
- **No seat supervises anything.** Quality gating is the standalone critic (`orchestrator-runtime.ts:969-1005`). On escalate the step is blocked and a message goes to the human founder, not to a seat (`apps/web/lib/orchestrator.ts:219-232`, `store.addCeoMessage`). The escalation role is remapped to ceo (`orchestrator-runtime.ts:87`) and `apps/web/lib/agent-routing-context.ts:58-61` says so outright: escalation is not a seat, it is a feature of the approval flow. Delegated child steps are created with no CEO authorisation step, contradicting the manifest anti-pattern at `seat-manifest.ts:103`.

### 1.7 The 164 specialists vs the seats

- Catalog `AGENT_CATALOG` at `apps/web/lib/agent-catalog.ts:60`; exactly 164, proven `packages/trent-core/src/agents/catalog.test.ts:22-24` and `packages/trent-core/src/fleet/FleetManager.test.ts:37-39`.
- Specialists are **not seats**: they are plug profiles that override a seat's prompt. `apps/web/lib/agent-runtime.ts:69-103` — a plugged profile replaces `basePrompt` (`:92-99`) and rewrites `slotContract.mission` (`:102`); tools, budget and gates stay the seat's (`:74`). Only 3 carry V3 depth with an `evalSuite` (`agent-catalog.ts:2068-2136`).
- Install writes `<agentsDir>/<id>.json` plus materialised skill files and appends to `fleet.installed_agents` / `active_agents` (`AgentInstaller.ts:250-286`, path `:363`). Tests `AgentInstaller.test.ts:83,115,139,160`. Fleet listing 164+9 (`FleetManager.ts:84-120`, test `FleetManager.test.ts:77-79`).

### 1.8 Personalities module

`packages/trent-core/src/personalities/` (`PersonalityManager.ts:6-40`, `built-in.ts`) reads
`<profile>/personalities/*.json` for a `systemPromptSuffix`. It is **dead with respect to the seats**.
Searches run:
`grep -rn "personalities\|PersonalityManager" --include="*.ts" --include="*.tsx" apps packages | grep -v "src/personalities/"`
-> only `apps/cli/src/slash/index.ts:6,18`, its test, the barrel re-export `packages/trent-core/src/index.ts:7`,
the package export map, and the dir helper `config/ConfigManager.ts:93`. Zero hits under `apps/web`,
zero in `agent-runtime.ts` / `orchestrator*`. The suffix never reaches `getAgentRuntime`'s prompt
assembly (`agent-runtime.ts:135`).

---

## 2. Persistent memory

Root correction: the DB is **not** `~/.trent/trent.db`. It is `<profileDir>/trent.db`, i.e.
`~/.trent/profiles/<profile>/trent.db` — `apps/cli/src/runtime/headless.ts:210`, proven
`apps/cli/src/runtime/headless.test.ts:165`. Trent home `config/ConfigManager.ts:44`; profile dir `:65-67`.

### 2.1 The durability cliff

`apps/cli/src/runtime/headless.ts:110-119`: `createSqliteStore` is imported dynamically and, on any
throw, the runtime falls back to `EphemeralStore` (`apps/cli/src/repl/ephemeral-store.ts:1-7`).
The driver is `bun:sqlite` (`packages/trent-core/src/store/createStore.ts:4`), which has no Node
equivalent. So under `npm run cli` / `tsx` (root `package.json:15`) **every durable layer below is
in-memory**: runs, steps, events, approvals, traces, skill drafts, the improve ledger, GEPA
frontiers, agent versions. Only the plain-file layers survive. The shipped Bun binary
(`dist/binaries/trent-darwin-arm64`) is durable. The warning is printed at `apps/cli/src/repl/index.ts:169-174`.

### 2.2 File layers under `<profile>/`

| Path | Writer | Contents | Limit | Lost on restart |
|---|---|---|---|---|
| `config.yaml`, `.env` | founder / `trent setup` | config incl. `memory.blocks` | — | no |
| `memories/{MEMORY,USER,COMPANY}.md` | `memory` tool (agent); consolidator via human promote | `\n§\n`-separated entries | 2200 / 1375 / 1500 chars (`tools/memory/blocks.ts:31,39,46`) | no |
| `sessions/*.json` | TUI + gateway handler only | transcript rows | prune 30d / maxCount (`sessions/SessionStore.ts:48`) | no |
| `gateway.json` | `gateway/GatewayManager.ts:81`, `apps/cli/src/gateway/agent-handler.ts:85` | pairings, outbound queue, approvals, thread->session map (`gateway/store/GatewayStore.ts:70-84`) | — | no |
| `cron/jobs.json` | `cronjob_manage` **agent tool** (`tools/cron/index.ts:111,167-171`) | scheduled jobs | — | no |
| `cron/runs/<jobId>.jsonl` | `cron/CronRunner.ts:73,231` | run rows | 50 (`CronRunner.ts:32`) | older dropped |
| `heartbeat/runs.jsonl` | `heartbeat/HeartbeatLoop.ts:92,305-310` | tick rows | 200 (`:25`), 0600 | older dropped |
| `HEARTBEAT.md` | founder | heartbeat checklist | — | no |
| `skills/` | `skill_manage` **agent tool** (`tools/skills/store.ts:18,75,91-104`) | `SKILL.md` + refs/scripts/assets | — | no |
| `exemplars/<goldenId>.json` | `trent improve promote` (`apps/cli/src/commands/improve.ts:191-193`) | rationalised exemplars | — | no |
| `idempotency.json`, `plugins/`, `cache/spillover`, `agents/`, `personalities/`, `logs/` | tools / installer | — | — | cache only |
| `~/.trent/egress/{tokens.json,ca.crt,ca.key}` | `egress/TokenManager.ts:33`, `egress/CertificateAuthority.ts:40` | **global, not per-profile** | — | no |
| `<cwd>/evals/orchestration-goldens/golden-<runId>.json` | golden capture hook | quarantined failure fixtures | 1/run | cwd-relative (`apps/web/lib/orchestration-golden-capture.ts:40-44,74`) |

`~/.trent/traces` is ABSENT as a layer — only a doctor writability probe
(`packages/trent-core/src/doctor/checks/self-improvement.ts:10-27`).

### 2.3 SQLite tables

66 models in `packages/trent-core/prisma/schema.sqlite.prisma`, byte-identical model list to
`apps/web/prisma/schema.prisma`. Schema is derived from `prisma/init.sql`, applied once when the probe
table `OrchestratorRun` is missing (`store/createStore.ts:30-56`). Groups:
identity/tenancy (`User`, `Company`, `CompanyMember`, `Agent`, `AgentPlugAssignment`, `AgentEntitlement`);
work (`Task`, `Cycle`, `Goal`, `Approval`, `AgentExecution`, `JobRun`, `Report`, `CeoMessage`);
orchestration (`OrchestratorRun` / `Step` / `Event` — the durable record recall reads back);
workbench (6); missions (5); memory/knowledge (`Document` with `memoryTier`/validity window/`supersedesId`
at `schema.prisma:402-420`, `Artifact`, `CompanyPlaybookEntry`, `CreativePerformanceMemory`,
`CompanyCustomSkill`); improve (`AgentTrace`, `SkillDraft`, `SelfImprovementIteration`);
integrations/billing/ads/social (~30).

`StorePort` exposes only a narrow slice — companies, runs, steps, events, approvals, jobRuns, audit
rows (`store/StorePort.ts:193-230`); there is no `listRuns`, so the REPL writes a
`JobRun{type:"trent_run"}` index row to re-find its own runs (`apps/cli/src/repl/memory.ts:1-18`).
Durability tests: `store/store.durability.test.ts:70-99`; approvals across processes
`apps/cli/src/repl/__tests__/approvals.restart.test.ts:74`.

Improve tables are bootstrapped by raw SQL into the same file (`improve/sqlite-store.ts:49-100`):
`GepaFrontier` (`:66-72`), `SkillLedger` with full before/after bytes and `judgeAgreement` (`:73-89`),
`GateCache` (`:90-96`), plus `AgentVersion` (`improve/sqlite-agent-versions.ts:15-29`) and added columns
on `AgentTrace` / `SkillDraft` / `SelfImprovementIteration`. Reopen test: `improve/store.test.ts:35,43`.

### 2.4 `--continue` restores nothing

- `apps/cli/src/index.ts:35` -> `apps/cli/src/repl/index.ts:101` `this.#sessions.resumeLastSession()`.
- `resumeLastSession` only sets an in-memory field (`sessions/SessionManager.ts:48-56`).
- `#sessions` appears nowhere else in `apps/cli/src/repl/index.ts` (lines 92, 98, 101 only); the engine is constructed without it (`:152-167`) and the runner passes the bare objective (`:150`, `apps/cli/src/repl/engine.ts:385`).
- The REPL never *writes* sessions either: no `startSession` / `appendMessage` caller under `apps/cli/src/repl/`. Writers are `apps/cli/src/tui/hooks/useSession.ts:19,29` and `apps/cli/src/gateway/agent-handler.ts:98,104`.
- Even the gateway, which does append, runs with `message.content` alone (`agent-handler.ts:101`) — prior turns never re-enter the prompt.
- `trent sessions resume` prints `messages: session.messages.length` and restores nothing (`apps/cli/src/commands/groups/sessions.ts:69,82`).
- ABSENT: any test asserting conversation replay. Greps run: `grep -rn "continueSession\|resumeLast" apps/cli/src/repl/__tests__ apps/cli/src/commands/__tests__` -> none. `SessionManager.test.ts:79` asserts the record only.

Net: there is **no conversational continuity anywhere in the CLI**. Every turn is a stateless
orchestration run. The only cross-turn continuity is the memory blocks plus fleet recall.

### 2.5 Memory the agent writes itself

Tool-initiated writes exist and are gated:
`memory` tool -> MEMORY.md / USER.md (`tools/memory/index.ts:186-221`); delegated children refused
(`:192-194`), `read_only` blocks refused by label (`:195-202`), hard char cap.
`cronjob_manage` -> `cron/jobs.json`, i.e. an agent can schedule its own future runs
(`tools/cron/index.ts:167-171`; terminal-bearing jobs need approval `:325`).
`skill_manage` -> skills on disk, trust stamped `community` (`tools/skills/index.ts:42,58-59,78`).
Automatic, no agent intent: trace rows (`improve/trace-writer.ts`), golden capture, quarantined
skill drafts. Human-only door for anything going live: `improve/lifecycle.ts:94-96`.
Founder-only: COMPANY.md, HEARTBEAT.md, config, `.env`.

**Aspirational, not real:** every seat manifest declares `writesOnFinish` memory keys
(`seat-manifest.ts:277`, `agent-catalog.ts:2091,2112,2132`), and `agent-runtime.ts:209` renders them
into the prompt as text. Nothing writes those documents — `grep -rn "writesOnFinish" apps/web/lib`
returns only the type, the data and the prompt string.

---

## 3. The shared brain

### 3.1 What is actually shared, and the test that proves it

| Surface | Code | Test |
|---|---|---|
| Named memory blocks | `tools/memory/index.ts:155`; defaults `tools/memory/blocks.ts:26-48`; prelude `:145-153` | `tools/memory/memory.test.ts:182,195,204,221` |
| Cross-agent step-output recall | `fleet-memory/recall.ts:86`, candidates `:59-84` | `fleet-memory/fleet-memory.test.ts:64,78,98` |
| `fleet_search` | `fleet-memory/search.ts:79-103` | `fleet-memory.test.ts:107,118,128` |
| `fleet_skill_view` + shared skills index | `fleet-memory/search.ts:105-114`, `fleet-memory/shared-skills.ts:27-38` | `fleet-memory.test.ts:138,151` |
| Prelude identical for every seat | `fleet-memory/orchestrator-hook.ts:92-108,122-135` | `fleet-memory.test.ts:226`; real pipeline `fleet-memory.orchestrator.test.ts:148` |

Wiring is real: adapters merged `orchestrator/index.ts:231`, seat wrap `:232,250`, `runStarted` `:365`,
`runFinished` `:439`; built once in `apps/cli/src/runtime/headless.ts:215` via
`apps/cli/src/repl/fleet-memory.ts:36-40`.

### 3.2 Ranking is lexical. There is no semantic index in the CLI.

- Recall: TF-IDF + cosine computed at query time over the candidate corpus — `fleet-memory/lexical.ts:50-66` (df `:53`, `idf = log(1 + n/(1+count))` `:57`, `tf-idf = (1+log(freq)) * idf` `:63`), cosine `:43-47`, applied `recall.ts:90`, min score 0.12 (`recall.ts:93`, `fleet-memory/config.ts:27`).
- `fleet_search` does not use TF-IDF at all: `fullTextScore` (`lexical.ts:79-86`) is distinct-token overlap plus a capped density term. Not BM25 — no k1/b.
- **No embeddings anywhere in the path.** `EmbedFn` is a seam (`lexical.ts:11`, `orchestrator-hook.ts:104`) and nothing ever passes `embed:`. The CLI omits it (`apps/cli/src/repl/fleet-memory.ts:39`).
- `packages/trent-core/prisma/*.prisma`: `grep -niE "embedding|vector"` -> 0 hits. `faiss` 0, `hnsw` 0, `pgvector` 1 hit and it is a comment.
- The only real vector search in the repo lives in `apps/web` and is unreachable from the CLI: `apps/web/lib/wiki-embeddings.ts` (OpenAI `text-embedding-3-small` `:20,105-118`, 384-dim `:21`, JSONL persistence `:25-26`, cosine top-K `:179`), `apps/web/lib/semantic-router.ts:98-122`.
- Knowledge graph: `apps/web/lib/vault-graph.ts:52` is a file/link graph, not an entity KG. Entity model ABSENT.

### 3.3 Budget and writers

- `recallBudgetChars` default 3000 (`fleet-memory/config.ts:24`), enforced `recall.ts:99-104`; overflow is **skip-and-continue**, counted as `dropped` (`recall.ts:108-110`). Test `fleet-memory.test.ts:85`.
- `TRENT_FLEET_RECALL_BUDGET_CHARS` (advertised `fleet-memory/README.md:17`) is **dead**: its only reader `resolveFleetMemoryConfig` (`config.ts:34-38`) is called from nowhere; the hook uses `DEFAULT_FLEET_MEMORY_CONFIG` (`orchestrator-hook.ts:76`).
- Two writers: `commitOperations` (`tools/memory/store.ts:178-195` — lock, re-read, apply on fresh entries, cap, write-then-rename 0600) and the human-gated promotion path (`fleet-memory/consolidate.ts:261-277`).
- Lock is `mkdir`-based, not `flock`: `acquireLock` (`tools/memory/store.ts:145-170`), 5s stale break (`:131,162`), 2s deadline (`:132,166`). Multi-process proof: `tools/memory/memory.test.ts:157` spawns two real `execFile` children, 20 appends each, asserts 40 entries under cap.
- Escape hatch: `replaceBlock` bypasses the lock when byte-identical duplicates exist (`fleet-memory/memory-draft.ts:109-114`); no concurrency test covers that branch.

### 3.4 Company memory in apps/web the CLI does NOT wrap

`trent-core` imports 34 `@/lib/*` modules (`grep -rho '"@/lib/[a-z0-9./-]*"' packages/trent-core/src | sort -u`);
`fleet-memory` uses exactly two (`fleet-memory/app-source.ts:43,63`). Unwrapped company-memory surfaces:

1. `apps/web/lib/memory-tiers.ts` — the repo's real three-tier model: `WorkingMemory:38`, `EpisodicMemory:122`, `SemanticMemory:192` with a supersedes chain, `writeEpisodicMemory:248`.
2. `apps/web/lib/vault-memory.ts` — scoped vault memory with approval gates (`LocalVaultMemoryProvider:137`, `GitNexusVaultIndexAdapter:196`).
3. `apps/web/lib/wiki-embeddings.ts` — the only real vector memory.
4. `apps/web/lib/trench-wiki.ts` + `trench-wiki-indexer.ts` + `wiki-notes.ts` — wiki over `Document` with chunking and backlinks.
5. `apps/web/lib/capability-memory.ts` — capability outcome records (`chooseBestCapability:53`).
6. `apps/web/lib/seat-memory-registries.ts` — per-seat registries and a second recall (`buildSeatRegistryRecall:81`).
7. `apps/web/lib/run-memory-log.ts`, `agent-mission-memory-log.ts`, `content-mission-memory-log.ts`.
8. `apps/web/lib/company-memory-upload.ts` — founder uploads into company memory.
9. `apps/web/lib/active-documents.ts` — validity-window filter over company documents.
10. `apps/web/lib/vault-graph.ts` — vault graph model.
11. `apps/web/lib/gbrain/` — external brain service: `ingestMissionMemory:20`, `recallMissionContext:41`.
12. `apps/web/lib/cross-company-learning.ts`, `ceo-decision-journal.ts`.
13. `apps/web/lib/attio-crm-adapter.ts:27` — the only CRM surface.
14. `apps/web/lib/source-coverage.ts` — grounding against company memory (`buildSourceCoverage:104`).

Related: the CLI's `/wiki` command ("Inspect company memory and knowledge graph") returns hardcoded
strings — "Total Knowledge Nodes: 24" at `apps/cli/src/slash/index.ts:363`. It wraps nothing.

One per-seat recall IS live in the wrapped path: `buildMemoryPlanBlock` (`apps/web/lib/agent-runtime.ts:168-211`)
filters `store.listDocuments` by `memoryTier` and case-insensitive substring match (`:190-191`), caps at 6
documents (`:194`). Substring, not semantic.

### 3.5 Propagation: next run, never within a run

`frozenSnapshot()` memoises on first call (`tools/memory/index.ts:176-179`); `thaw()` (`:180-182`) runs
only from `runFinished` (`fleet-memory/orchestrator-hook.ts:141-146`), called at `orchestrator/index.ts:439`.
Recall is frozen the same way (`orchestrator-hook.ts:127`). The tool result tells the model so:
"Shared with every seat in the company from the next run on" (`tools/memory/index.ts:219`).
Proof: `fleet-memory/fleet-memory.test.ts:171` (runs 1-2 lack the fact, run 3 has it); real pipeline
`fleet-memory.orchestrator.test.ts:130,148`. Skills propagate only after human promotion to the
`__org__` tier (`shared-skills.ts:29` filters `status: "live"`). **Failures have no channel at all** —
they surface only as step outputs inside recall.

### 3.6 Consolidation

`consolidateMemory` (`fleet-memory/consolidate.ts:152-220`) makes one temperature-0 call and writes
**nothing to disk**: a quarantined `SkillDraftRow` (`:184,192`), a `pending_approval` iteration (`:203`)
and a `stage` ledger row carrying the current bytes (`:210-218`). Only `memory` and `user` are
consolidated (`memory-draft.ts:32`) — COMPANY.md is never written by anything, contradicting
`blocks.ts:44` and `README.md:16`. Promotion is hard-gated: `consolidate.ts:265`
`if (options.actor !== "human") throw new ProtectedPromptError(...)`; test `consolidate.test.ts:164`.
The heartbeat does schedule the draft: `maybeConsolidate` (`heartbeat/HeartbeatLoop.ts:291-303`),
called from the tick at `:231`; tests `HeartbeatLoop.test.ts:176,196`. So the heartbeat drafts nightly
and the files change only when a human promotes.

---

## 4. Self-improvement

### 4.1 Automatic vs explicit

- Automatic on every CLI run: trace writing and skill injection (`apps/cli/src/runtime/headless.ts:217` -> `apps/cli/src/repl/improve-loop.ts:23-27`). `SKILL_INJECTION_ENABLED` is off by default in the web app (`apps/web/lib/orchestrator-runtime.ts:53`) but the CLI's standalone env sets it to `"1"` (`packages/trent-core/src/runtime/env.ts:56`).
- **The heartbeat does no self-improvement.** `HeartbeatLoop` runs one model turn over `HEARTBEAT.md` plus fleet state (`heartbeat/HeartbeatLoop.ts:208-217,227-241,243-270`); default checklist `heartbeat/checklist.ts:13-23`. `grep -rn "runImprovementSweep" packages/trent-core/src/heartbeat` -> 0 hits. It is also opt-in and off by default (`config/schema.ts:97`), started only by `trent heartbeat start` (`apps/cli/src/commands/groups/heartbeat.ts:149`) or `serve` when enabled (`apps/cli/src/commands/groups/servers.ts:254-269`).
- Only explicit: `trent improve sweep` (`apps/cli/src/commands/improve.ts:224-247`). No cron job wires it (`grep -n "improve\|sweep" apps/cli/src/commands/groups/cron.ts` -> 0).
- **Golden capture is silently off in the CLI**: `wireImproveLoop` passes no `goldenDir` (`apps/cli/src/repl/improve-loop.ts:24-27`) and `improve/hook.ts:33` builds the capture only when `goldenDir !== undefined`. Production CLI runs capture zero failure goldens.

### 4.2 What gets improved

`ImproveArtifactKind = "skill" | "prompt" | "memory" | "agent"` (`store/StorePort.ts:244`). The sweep
produces only **skill** (`improve/sweep.ts:275`) and **prompt** (`improve/gepa-pass.ts:161` via
`improve/protected-prompt.ts:77`); `memory` and `agent` appear only on the rollback path
(`improve/lifecycle.ts:245-267,270-273`). Tools ABSENT (no `kind: "tool"`; tool health is a read-only
signal, `sweep.ts:160-170`). Routing ABSENT (`grep -rn 'kind: "routing"' packages/trent-core/src/improve` -> 0).

### 4.3 Verifier and eval suites — no seat can promote

- The gate refuses without a suite: `sweep.ts:192` `blockedBy: "no_suite"`; without model access `:193`; without a baseline `:197`.
- It refuses a rubric-only suite with no judge: `improve/gate.ts:60` `if (verdict.pendingRubrics > 0) return { ...verdict, blockedBy: "unverified" }`, counter at `gate-score.ts:103-106`. Tests `gate.test.ts:135` (the vacuous gate) and `:150` (mechanical-only needs no judge).
- **No seat has a suite.** The CLI resolves suites with `fileSuiteProvider(..., (agentId) => getCatalogAgent(agentId)?.skills ?? [])` (`apps/cli/src/commands/improve.ts:243`). `getCatalogAgent` searches `AGENT_CATALOG` by id (`apps/web/lib/agent-catalog.ts:2064-2065`), whose 164 ids are all `eng-*` / `spec-*` style; `grep -c 'id: "growth"\|id: "ceo"\|id: "engineer"' apps/web/lib/agent-catalog.ts` -> **0**. Seat skills live in `SLOT_ENVIRONMENTS` (`agent-catalog.ts:1977-2048`), which that lookup never reads. Every seat therefore resolves `suite === undefined` -> `no_suite`, and GEPA skips for the same reason (`gepa-pass.ts:95`).
- Only two skills ship `evals.json`: `apps/web/.agents/skills/{ads,prospecting}/evals/evals.json` out of 113 skill dirs. The one mechanical overlay (`packages/trent-core/src/improve/overlays/ads/evals/mechanical.json`, 6 `contains` graders) is dead in the CLI because no agent resolves the `ads` skill. Overlay tests `improve/suites.test.ts:70,98` prove the file, not the wiring.

### 4.4 Goldens

Two kinds. Failure goldens from bus events (`improve/golden-capture.ts:51-57`, written via
`apps/web/lib/orchestration-golden-capture.ts:74`, status quarantined, one per run; tests
`golden-capture.test.ts:50,65`) — not wired in the CLI. Exemplar goldens from human approvals:
`lifecycle.ts:113` `if (options.distill) await distillExemplars(...)`, body `:50-73`, process-clean runs
only (`improve/clean-trace.ts`), stored in `<profile>/exemplars/` (`apps/cli/src/commands/improve.ts:191-193`);
test `lifecycle.test.ts:174`.

### 4.5 Judge and the judge-vs-human ledger

`createGatewayJudge` (`improve/judge.ts:57-65`), temperature 0, 256 max tokens, prompt a hardcoded
constant (`judge.ts:19-25`) requiring 8-120 chars of verbatim evidence; non-JSON replies fail closed
(`judge.ts:32-44`). Meta-verification is implemented and free: `verifyEvidence` (`gate-score.ts:85-89`),
called `:124-127`, tag `judge_unverified` (`gate-score.ts:24`); tests `gate.test.ts:214`, `judge.test.ts:66`.
Agreement ledger: `judgeAgreementFor` (`improve/ledger.ts:47-55`) written on human promote
(`lifecycle.ts:113`) and human reject (`:135-136`); calibration metric `judgeAgreementOf`
(`improve/status.ts:59-68`) rendered by `trent improve status` (`apps/cli/src/commands/improve.ts:216`);
test `lifecycle.test.ts:147`.

### 4.6 Promote / rollback gate

Human only: `improve/lifecycle.ts:94-96` throws `ProtectedPromptError` for any non-human actor. Seat
prompts cannot be written directly at all — `improve/protected-prompt.ts:41-46` always throws, and
staging requires a passed gate verdict (`:59-70`). Tests `protected-prompt.test.ts:14,25,71`.
Rollback restores the prior bytes from the ledger `before` column (`lifecycle.ts:276-313`), flips agent
version labels (`:245-267`) and writes memory files back first (`:270-273`); byte-exact test
`lifecycle.test.ts:84,112`. **Contrast:** `apps/web/lib/heartbeat.ts:191-199` auto-promotes with no
human, test `apps/web/lib/self-improvement-sweep.test.ts:84`.

### 4.7 Cost cap

`SweepMeter` (`improve/meter.ts:59-68`), phases `baseline|candidate|gepa|judge|rationalise` (`:21,45-53`),
`BudgetExhaustedError` (`:31-39`). **No default budget**: `SweepDeps.budgetCents?` (`sweep.ts:57`) ->
`new SweepMeter(input.budgetCents)` (`sweep.ts:388`), `limitCents: ... ?? null` (`:404`), and the CLI
never passes it (`grep -n budget apps/cli/src/commands/improve.ts` -> 0). No env var
(`grep -rn "BUDGET_CENTS\|TRENT_IMPROVE" apps packages` -> 0). `trent improve sweep --live` is uncapped.
When spent the draft stays quarantined (`sweep.ts:212`); test `sweep.test.ts:202,227`.

### 4.8 GEPA Pareto frontier

Real and persisted per (company, agent): `gepa-pass.ts:99,103-109`. Selection is wrapped, not
reimplemented: `packages/trent-core/src/gepa/index.ts:96-106` -> `apps/web/lib/gepa.ts:139-175`. The
diversity axis is the failure-cluster profile (`gepa.ts:144-145`), one slot per profile keeping the top
scorer (`:150-157`); over capacity it sorts by **score alone** (`:161-164`). So it is a real frontier but
**weak Pareto** — no dominance test, cost and latency never enter selection. Tests
`packages/trent-core/src/gepa/pareto.test.ts:22,44,54`; end-to-end `sweep.test.ts:91`; two-slot behaviour
`gate.test.ts:261`. Two cost filters from the CS329A analysis are implemented: saturated-suite skip and
a 25% proposal-length cap (`gepa-pass.ts:11-15`).
**But the CLI passes `skipLLM: true` unconditionally** (`apps/cli/src/commands/improve.ts:244`), so even
`--live` never runs a reflection model — the proposal is the fixed marker `"\n<!-- gepa evolved -->"`
(`gepa-pass.ts:62,140`).

### 4.9 apps/web heartbeat defect 4 — verified, and bypassed not wrapped

`apps/web/lib/heartbeat.ts:334-337` constructs `new InMemoryTraceStore()` and
`new InMemorySkillDraftStore()` for every sweep; `runSelfImprovementSweep` then returns early at
`heartbeat.ts:134-135` because a fresh trace store is always empty. Confirmed NO-OP.
`trent-core` does not wrap it: `grep -rn "@/lib/heartbeat" packages` -> 0 hits. The CLI runs its own
`packages/trent-core/src/improve/sweep.ts` against the durable `ImproveStorePort`, and that file's
docstring names the defect it replaces (`sweep.ts:4`). `apps/web/lib/heartbeat.ts` is reachable only
from the Next.js app.

### 4.10 Self-authored skills

Yes, and gated three ways. `createSkillFoundry(...).distill(...)` (`improve/sweep.ts:246-251`, wrapper
`skills/foundry.ts`); deterministic triggers from run outcomes (`traces/trace-store.ts:147-158`, union
`:99-105`). Gates: always `status: "quarantine"` (`sweep.ts:276`); must pass the executing gate
(`sweep.ts:187-223`); quarantine -> live only via human `promoteDraft` (`lifecycle.ts:94-96`). Input is
restricted to process-clean traces (`sweep.ts:111-115,249`; `no_clean_trace` at `:268`). Tests
`sweep.test.ts:43,292,305`; CLI round-trip `apps/cli/src/commands/__tests__/improve.test.ts:101,134`.

Note: every `*.live.test.ts` (16 files) is gated behind `TRENT_TEST_LIVE=1`, so none of the real-model
proofs run in the standard gate.

---

## 5. Verdict table

REAL = wired end to end with a test. PARTIAL = exists but not wired, limited, or one path only.
STUB = placeholder or degraded path.

| # | Item | Verdict | Most telling file:line |
|---|---|---|---|
| 1.1 | Nine seats defined with roles, prompts, contracts | REAL | `apps/web/lib/seat-manifest.ts:109` |
| 1.2 | Nine seats *runnable* | STUB | `apps/web/lib/orchestrator-runtime.ts:81` (5 active, 4 remapped) |
| 1.3 | Two rosters agree (browser vs sales) | STUB | `packages/trent-core/src/fleet/AgentInstaller.ts:111` |
| 1.4 | Task -> plan -> seat routing | PARTIAL | `apps/web/lib/orchestrator-runtime.ts:105` (regex fallback to ceo) |
| 1.5 | Critic | REAL (not a seat) | `apps/web/lib/orchestrator-runtime.ts:978` |
| 1.6 | Consolidator | REAL (not a seat) | `apps/web/lib/orchestrator-runtime.ts:1068` |
| 1.7 | Per-seat tools enforced | PARTIAL (web only) | `apps/web/lib/seat-agent-loop.ts:212` vs `packages/trent-core/src/orchestrator/seat-wiring.ts:45` |
| 1.8 | Per-seat budgets enforced | STUB | `apps/web/lib/orchestrator-runtime.ts:1428` (never compared to spend) |
| 1.9 | Per-seat models | PARTIAL / STUB in CLI | `apps/web/lib/model-gateway.ts:106`; `packages/trent-core/src/orchestrator/model-env.ts:69` |
| 1.10 | Per-seat verifier / eval suite | STUB | `packages/trent-core/src/improve/sweep.ts:192` (`no_suite` for every seat) |
| 1.11 | `delegate_task` | PARTIAL (CLI only) | `apps/cli/src/runtime/headless.ts:193` |
| 1.12 | CEO / escalation supervision | STUB | `apps/web/lib/agent-routing-context.ts:58` ("escalation is not a seat") |
| 1.13 | 164 specialists installable | REAL | `packages/trent-core/src/fleet/AgentInstaller.ts:250` |
| 1.14 | Specialists differ from seats when installed | PARTIAL | `apps/web/lib/agent-runtime.ts:74` (prompt only; seat keeps tools/budget) |
| 1.15 | Personalities module wired | STUB | `packages/trent-core/src/index.ts:7` (only export; zero run-path importers) |
| 2.1 | SQLite store durability | PARTIAL | `apps/cli/src/runtime/headless.ts:114` (Node -> EphemeralStore) |
| 2.2 | Orchestrator runs/steps/events persisted | REAL | `packages/trent-core/src/store/store.durability.test.ts:70` |
| 2.3 | Improve tables (frontier, ledger, versions, gate cache) | REAL | `packages/trent-core/src/improve/store.test.ts:35` |
| 2.4 | Named memory blocks on disk | REAL | `packages/trent-core/src/tools/memory/memory.test.ts:157` |
| 2.5 | Sessions store | PARTIAL | `packages/trent-core/src/sessions/SessionStore.ts:48` (written by TUI/gateway only) |
| 2.6 | `--continue` restores conversation + tool state | STUB | `apps/cli/src/repl/index.ts:101` (record only; `#sessions` used nowhere else) |
| 2.7 | Per-seat memory namespace | PARTIAL | `apps/web/lib/agent-catalog.ts:2056` (prompt text; no per-seat store) |
| 2.8 | Seat `writesOnFinish` memory | STUB | `apps/web/lib/agent-runtime.ts:209` (rendered, never executed) |
| 2.9 | Agent-initiated memory writes | REAL | `packages/trent-core/src/tools/memory/index.ts:186` |
| 2.10 | Cron / heartbeat / gateway state persisted | REAL | `packages/trent-core/src/heartbeat/HeartbeatLoop.ts:305` |
| 2.11 | Traces durable | PARTIAL | `apps/cli/src/repl/index.ts:158` (REPL view is an `InMemoryTraceStore`) |
| 3.1 | Cross-seat recall of step outputs | REAL | `packages/trent-core/src/fleet-memory/fleet-memory.test.ts:64` |
| 3.2 | `fleet_search` / `fleet_skill_view` | REAL | `packages/trent-core/src/fleet-memory/search.ts:79` |
| 3.3 | Shared memory blocks across seats | REAL | `packages/trent-core/src/fleet-memory/orchestrator-hook.ts:93` |
| 3.4 | Semantic ranking | STUB (lexical) | `packages/trent-core/src/fleet-memory/lexical.ts:63` |
| 3.5 | Vector store / KG / entity model in the CLI | ABSENT | prisma schemas: `grep -niE "embedding\|vector"` -> 0 |
| 3.6 | Recall budget + two-writer lock | REAL | `packages/trent-core/src/tools/memory/store.ts:145` |
| 3.7 | `TRENT_FLEET_RECALL_BUDGET_CHARS` | STUB | `packages/trent-core/src/fleet-memory/config.ts:34` (reader never called) |
| 3.8 | A learns -> B sees it | PARTIAL (next run only) | `packages/trent-core/src/tools/memory/index.ts:176` |
| 3.9 | Failure propagation between seats | ABSENT | no failure channel; only step outputs in recall |
| 3.10 | apps/web company memory wrapped by CLI | STUB | `packages/trent-core/src/fleet-memory/app-source.ts:43` (2 of ~14 surfaces) |
| 3.11 | `/wiki` company knowledge command | STUB | `apps/cli/src/slash/index.ts:363` (hardcoded counts) |
| 3.12 | Memory consolidation | REAL (drafts only) | `packages/trent-core/src/fleet-memory/consolidate.ts:265` |
| 4.1 | Trace capture on every run | REAL | `packages/trent-core/src/improve/trace-writer.ts` + `improve.test.ts:134` |
| 4.2 | Heartbeat runs the sweep | ABSENT | `packages/trent-core/src/heartbeat/HeartbeatLoop.ts:228` (no improve call) |
| 4.3 | Sweep improves skills and prompts | REAL (mechanism) | `packages/trent-core/src/improve/sweep.ts:275` |
| 4.4 | Sweep can promote for a seat | STUB | `packages/trent-core/src/improve/sweep.ts:192` |
| 4.5 | Executing gate + unverified block | REAL | `packages/trent-core/src/improve/gate.ts:60` |
| 4.6 | LLM judge + evidence meta-verification | REAL | `packages/trent-core/src/improve/gate-score.ts:85` |
| 4.7 | Judge-vs-human agreement ledger | REAL | `packages/trent-core/src/improve/status.ts:59` |
| 4.8 | Human-only promote / byte-exact rollback | REAL | `packages/trent-core/src/improve/lifecycle.ts:94` |
| 4.9 | Failure golden capture in the CLI | STUB | `apps/cli/src/repl/improve-loop.ts:24` (no `goldenDir`) |
| 4.10 | GEPA reflection with a model | STUB in CLI | `apps/cli/src/commands/improve.ts:244` (`skipLLM: true`) |
| 4.11 | Pareto frontier | PARTIAL (weak) | `apps/web/lib/gepa.ts:161` (sorts by score alone) |
| 4.12 | Sweep cost cap | STUB | `packages/trent-core/src/improve/sweep.ts:404` (`limitCents: null`) |
| 4.13 | apps/web production sweep | STUB (no-op) | `apps/web/lib/heartbeat.ts:335` |
| 4.14 | Agent authors its own skills, gated | REAL | `packages/trent-core/src/improve/sweep.ts:276` |

---

## 6. Top 10 shortfalls against the vision

1. **Four of the nine seats cannot run.** `apps/web/lib/orchestrator-runtime.ts:81-90` remaps
   analyst/finance/escalation to ceo and sales to growth at `:414`. Smallest close: widen `ACTIVE_SEATS`
   to the full `AgentRole` union and delete `SHELVED_SEAT_ROUTING`.
2. **No seat can ever promote an improvement.** The CLI resolves eval suites through
   `getCatalogAgent(agentId)?.skills` (`apps/cli/src/commands/improve.ts:243`), which returns undefined
   for every seat id (`apps/web/lib/agent-catalog.ts:2064`), so the gate returns `no_suite`
   (`improve/sweep.ts:192`). Smallest close: fall back to `SLOT_ENVIRONMENTS[role].skills` for seat ids.
3. **No conversational memory at all.** `--continue` loads a session record and never replays it
   (`apps/cli/src/repl/index.ts:101`; `#sessions` appears nowhere else), and the REPL never writes
   sessions. Smallest close: append each turn to the session and prepend the last N turns to the
   objective the runner passes at `apps/cli/src/repl/index.ts:150`.
4. **The shared brain is lexical only.** Recall is TF-IDF cosine (`fleet-memory/lexical.ts:63`) and
   `fleet_search` is token overlap (`:79-86`); the `EmbedFn` seam is never given an embedder. Smallest
   close: pass the app's existing embedder (`apps/web/lib/wiki-embeddings.ts:105`) into
   `createFleetMemoryHook` as `embed`.
5. **The richest company memory in the repo is unreachable from the CLI.** `memory-tiers.ts`,
   `vault-memory.ts`, `wiki-embeddings.ts`, `trench-wiki.ts`, `capability-memory.ts`, `gbrain/`,
   `attio-crm-adapter.ts` and eight more are never imported by `packages/trent-core`
   (`fleet-memory/app-source.ts:43,63` uses two modules). Smallest close: extend `createAppFleetSource`
   to read `Document` rows through `active-documents.ts` and `memory-tiers.ts`.
6. **Nothing self-improves unattended.** The heartbeat has no improve call
   (`heartbeat/HeartbeatLoop.ts:228-241`), is off by default (`config/schema.ts:97`), and
   `trent improve sweep` is the only trigger. Smallest close: add a metered sweep step to
   `tickOnce` behind the existing `heartbeat.enabled` flag.
7. **GEPA never actually reflects in the CLI.** `skipLLM: true` is unconditional
   (`apps/cli/src/commands/improve.ts:244`), so the "evolved" prompt is the literal marker
   `"\n<!-- gepa evolved -->"` (`gepa-pass.ts:62,140`). Smallest close: set `skipLLM: !opts.live`.
8. **The sweep runs with no cost cap.** `limitCents: input.budgetCents ?? null` (`sweep.ts:404`) and the
   CLI passes nothing; no env var exists. Smallest close: default `budgetCents` from
   `config.budget.per_run_cap` (`config/schema.ts:50`) in `apps/cli/src/commands/improve.ts`.
9. **Failure goldens are never captured in production.** `wireImproveLoop` omits `goldenDir`
   (`apps/cli/src/repl/improve-loop.ts:24-27`), so `improve/hook.ts:33` builds no capture. Smallest
   close: pass `<profileDir>/goldens` as `goldenDir`.
10. **Per-seat budget and per-seat model are theatre.** `budgetCentsPerRun` is rendered into the prompt
    and set on the subtask (`agent-runtime.ts:122`, `orchestrator-runtime.ts:1428`) but never compared
    to spend, and `model-env.ts:69` writes one model into all three tier variables so every seat uses
    the same model. Smallest close: abort the seat loop when accumulated `costCents` exceeds
    `subtask.budgetCents`, and map config tiers rather than one model name.
