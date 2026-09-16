# Clusters F (work) G (money) H (CRM) J (channels/UX) — audit 2026-09-15

| # | Item | Status | Evidence | Missing |
|---|---|---|---|---|
| 1 | Initiative→Goal→Cycle→Task roll-up | PARTIAL | Task (schema L166) no goalId/cycleId/parentId; Cycle only ↔ AgentExecution; Goal only ↔ Company; goal-types successCriterion unmet/met/blocked; goal-loop.ts:259 passes cycleId: goal.id and persists Artifacts not Tasks | No Initiative; no Goal↔Cycle↔Task FKs; no hierarchy roll-up |
| 2 | Task deps + critical path | PARTIAL | dependsOn only on plan steps (types.ts:107 OrchestratorStep, goalTaskSchema, workbench-build-graph); cycles.ts:129 hardcodes dependsOn: [] | Task has no blocks/blocked-by; no critical path |
| 3 | Saved views + query language | ABSENT | hogql.ts = 3-line escape helper; queue UI filterAgent/filterStatus/sortBy only (sub-pages.tsx:2429) | all |
| 4 | Custom fields | ABSENT | Task.tags Json, Company.brief/metrics Json only | all |
| 5 | Templates/drafts/intake | PARTIAL | RecurringTaskTemplate + scheduler.ts:27; TaskStatus.draft; goal-intake.ts runGoalIntake; workbench templates = code scaffolds | no mission/project template model |
| 6 | Public form + email-to-task | PARTIAL | api/email/resend/webhook -> Document (not Task); gmail.ts outbound only | no public intake form; no email→Task |
| 7 | Kanban/Gantt/calendar | ABSENT/PARTIAL | queue = filtered list; calendar only for social posts (agent-mission-publishing-calendar.tsx) | no board/timeline over Tasks |
| 8 | Public roadmap/status | PARTIAL | app/public/[companySlug] gated by publicVisibility; Document.type roadmap | no curated roadmap/status page |
| 9 | Retros/Lean Canvas/SWOT/risk | ABSENT | ceo-decision-journal agent_note per run; cycles.ts:236 Report type cycle | no maintained artifacts |
| 10 | Bank feeds | ABSENT | wallet/ = MetaMask/Solana; price-feeds chainlink; stripe-read-adapter read-only | all |
| 11 | Client invoicing | PARTIAL | Invoice = usage billing only (payments/invoice-generator.ts generateMonthlyInvoice) | no customer invoices/links/dunning |
| 12 | Double-entry + statements | PARTIAL | ledger.ts recordTransaction debits==credits, idempotent; accounts billing|payout|spend only | no CoA, no P&L/BS |
| 13 | Multi-currency/tax/e-invoice | ABSENT | — | all |
| 14 | Period locking | ABSENT | — | all |
| 15 | Accountant export | ABSENT | — | all |
| 16 | Contacts/deals/pipelines | PARTIAL | SocialContact engagementState; attio-crm-adapter read-only; outbound/crm-sync.ts pure planner | no Deal/Pipeline/Stage |
| 17 | Mail/calendar sync | PARTIAL | google/google-client.ts (Gmail list/send, Calendar list/create), google-memory.ts one-shot ingest; gmail.ts approval-gated send; social/inbox.ts | no continuous sync, no M365 mail, no shared inbox |
| 18 | Sequences/WhatsApp/telephony | PARTIAL | outbound/sequences.ts pure (BUG: returns steps[0] regardless); channel-adapters plan-only; gateway whatsapp.ts real Graph API | no persisted enrolments, no Twilio/Vapi |
| 19 | Threads=sessions, reactions=approvals | PARTIAL | 8 platforms; ApprovalBridge buttons + text; handleInbound passes threadId; reactions outbound only | No inbound reactions; no thread→session map; **BUG: `gateway start` (apps/cli/src/commands/groups/servers.ts:186) never calls setAgentHandler → non-approval messages dropped, contradicting docs/gateway.md** |
| 20 | Voice | PARTIAL (stub) | voice/WhisperProcess.ts:53 transcribe() returns "Transcribed N bytes" placeholder; tts_enabled flag unconsumed; generation/audio-router.ts real TTS for content only | real STT, TTS replies, meeting bot |
| 21 | Dev UI step/replay | PARTIAL | orchestrator-trace-replay.ts -> orchestrator-trace-drawer.tsx read-only timeline; WorkbenchCheckpoint | no pause/resume-from-step/re-run from checkpoint |
| 22 | Device nodes | ABSENT | Tauri grants only event listen; vision reads files/URLs | all |

Surprises: Task/Goal/Cycle tables disconnected; goal loop bypasses Tasks; `gateway start` drops
chat messages (no agentHandler); voice STT is a placeholder; outbound/ is pure planners with no
storage; sequences.ts bug.
