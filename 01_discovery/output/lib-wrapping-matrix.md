# lib/ wrapping matrix (Stage 00)

| module | LOC | CLI-importable? | blocker |
|---|---:|---|---|
| trace-store.ts | 193 | YES | none (type-only imports) |
| eval-harness.ts | 112 | YES | none (zero imports) |
| readiness-controls.ts | 499 | YES | none (pure data, 35 controls) |
| mcp-connector-catalog.ts | 247 | YES | none (type-only imports, 9 connectors) |
| model-gateway.ts | — | YES | env must be in process.env before import |
| skill-foundry.ts | 374 | adapter | openai client + appendAuditLog; has `skipLLM` + injectable `auditLog` |
| gepa.ts | 293 | adapter | createAIClient; has `skipLLM` |
| agent-marketplace.ts | 191 | 10 of 13 exports | store.*AgentEntitlement for the other 3 |
| orchestration-golden-capture.ts | 183 | reads yes, capture no | fs + cwd default dir; capture needs 3 orchestrator models |
| heartbeat.ts | 366 | sweep yes, heartbeat no | runSelfImprovementSweep is fully DI'd; runCompanyHeartbeat needs 4 models + orchestrator |
| agent-catalog.ts | 2142 | YES | throws at import if skill map stale (assertSkillsInstalled) |
| orchestrator.ts | — | pending | owned by the orchestrator agent |

**That is 8+ modules importable or adapter-only — anti-pattern #2 is satisfiable.**

## Persistence: 13 Prisma models are touched in total
auditLog, orchestratorRun, orchestratorStep, orchestratorEvent, task, approval, cycle, document,
company, agentEntitlement, agentTrace, skillDraft, selfImprovementIteration.

**But only 4 tables are needed for the self-improvement loop**: agentTrace, skillDraft,
selfImprovementIteration, auditLog. A first standalone mode ships those four and leaves
runCompanyHeartbeat / captureOrchestrationFailureGolden / catalogWithAccess as app-only.

Three transaction sites matter for any SQLite port: audit-log.ts:44 (serializable, per CLAUDE.md),
skill-draft-store.prisma.ts:54 (quarantine->live promotion), prisma-store-base.ts:435 (entitlement grant).

## Pre-existing bug found (do not fix silently — report it)
`heartbeat.ts:335-336` constructs FRESH `InMemoryTraceStore` / `InMemorySkillDraftStore` for the sweep
inside `runCompanyHeartbeat`. The production heartbeat's self-improvement sweep therefore always reads
an empty trace store and is effectively a no-op. This is in the pre-existing app, not the new work.

## API hygiene to fix at the package boundary
- `parseDistillResponse` (skill-foundry.ts:280) is exported but its return type `LLMDistillResponse`
  (:197) is not — a public API leak.
- Eight marketplace exports have inferred rather than annotated return types; pin them in the wrapper.
- `readiness-controls.ts` declares a `"proof_required"` status arm that no entry uses.
