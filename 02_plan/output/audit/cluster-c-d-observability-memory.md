# Clusters C (observability/evals/cost) + D (memory) — audit 2026-09-15

## C
| # | Item | Status | Evidence | Missing |
|---|---|---|---|---|
| 1 | OTel export | PARTIAL | traces/OTelExporter.ts (gen_ai.* attrs, OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT, telemetry/redact.ts); improve/trace-writer.ts on orchestrator bus | **Exporter never instantiated outside tests**; one flat span per step, no tool child spans/parentSpanId; no Langfuse/Phoenix/LangSmith; slash/index.ts:411 banner claim aspirational |
| 2 | Cost attribution | PARTIAL strong | AgentTrace.costCents; OrchestratorRun.costCents/budgetCents; goal-store.ts:135 per-goal + budgetCentsCap; fleet/FleetUsage.ts per-agent; UsageLedgerEntry + spend.ts getSpendSummary; TUI useBudget + BudgetLedger; model-gateway/pricing.ts:34-40 incl. Gemini; improve/meter.ts | no cross-dimension rollup; no push alerting (UI banners only) |
| 3 | Virtual keys | PARTIAL | egress/TokenManager.ts agent-scoped tokens w/ ttl, revokeAllForAgent; CredentialBroker; spend.ts:108 assertAgentTokenBudget (UTC-day); FleetManager.ts:230 | tokens carry no spend budget; budget is app-layer preflight not enforced at key |
| 4 | Cost-aware routing | PARTIAL | model-policy.ts cheap/balanced/best; generation/cost-optimizer.ts selectModel; capability-memory.ts chooseBestCapability | no benchmark-driven "cheapest that passes" |
| 5 | Eval datasets + judge + queue | EXISTS mostly | improve/golden-capture.ts, clean-trace.ts, orchestration-golden-capture promote; improve/judge.ts, gate.ts, gate-cache.ts; `trent improve promote/reject`; ledger.ts judgeAgreementFor; eval-harness runEvalSuite | goldens capture objective+reason not corrected expected_output; no web annotation queue |
| 6 | Time-travel fork | PARTIAL | orchestrator-trace-replay.ts read-only; cycles/route.ts:51 fromExecutionId dev-only rerun; WorkbenchCheckpoint; SessionManager.resumeLastSession | no fork with edited state |
| 7 | Red-team CI | PARTIAL weak | skills/SecurityScan.ts, cron/prompt-scan.ts, mcp-policy, drift hashing; ci.yml vitest + repo-scan + swarm-regression | no adversarial corpus run against live agents; plug-evals no safety kind |
| 8 | SLOs per role | PARTIAL | skill-health.ts computeSkillHealth, tool-health.ts, gepa.ts worstPerformingRole; proof-dashboard, trust-panel | per skill/tool not per role; no latency/cost SLOs; no health UI page |

## D
| # | Item | Status | Evidence | Missing |
|---|---|---|---|---|
| 9 | Structured memory blocks | PARTIAL | tools/memory/index.ts two capped blocks (MEMORY.md 2200 / USER.md 1375), readOnly, atomic commitOperations, prepended to every seat prelude; memory-tiers.ts | fixed two blocks; no N named blocks w/ per-block limit/read_only |
| 10 | Human-editable memory in wiki | PARTIAL | CLI <profile>/memories/{MEMORY,USER}.md; web MemoryPageClient edits Documents; trench-wiki.ts:236 | CLI memory per profile not per company; not surfaced in web wiki |
| 11 | Sleep-time consolidation | PARTIAL | heartbeat.ts:119 runSelfImprovementSweep; docFreshness>48h refresh brief; consolidate_end brief; improve/lifecycle stale/archive | no job that dedupes/summarizes MEMORY/USER.md |
| 12 | Self-improving skills | EXISTS | skill-foundry distillSkillFromTraces; skills/foundry.ts; skill-derive; SkillDraft quarantine->promote + rollback; skill_manage tool self-edit (tools/skills/index.ts:42); improve/gepa-pass.ts | no immediate "save this run as a skill" command |
| 13 | Trigger-keyword microagents | EXISTS | CompanyCustomSkill.trigger (schema:250); agent-skill-instructions.ts:139 buildCustomSkillPrelude; CompanyPlaybookEntry | keyword only, no path/glob |
| 14 | Cross-session search | EXISTS | fleet-memory/search.ts fleet_search; recall.ts; trench-search.ts; api memory?q= | lexical not FTS5/embeddings; CLI SessionStore no search |
| 15 | Context condenser | PARTIAL | tools/spillover.ts; recall.ts dropped count | no REPL/orchestrator history compaction with visible summary |

Surprises: gate cache, sweep meter, protected seat prompts, org-tier promotion gate, judge-vs-human
ledger, repetitive-loop detection, quarantined vs blocking goldens, fleet memory freeze/thaw.
Biggest gaps: export side (OTel dead code) and time-travel.
