# Cluster B — HITL / approvals / policy (audit 2026-09-15)

| # | Item | Status | Evidence | Missing |
|---|---|---|---|---|
| 1 | Chat gateway approvals as buttons; reply resumes run | PARTIAL | gateway/ApprovalBridge.ts (createApprovalRequest, resolveCallback nonce+pending+isAdmin, buttons(), parseEmailReply); GatewayManager.ts:184 sendApproval; platforms/slack.ts:161 blocks; web api/approvals/[id] + orchestrate/approve resume; orchestrator-mid-loop-approval.test.ts:245 | Chat decision does NOT resume a run: gateway ApprovalRow has no runId/stepId; nothing calls orchestrator.approve on approval_decided except REPL bindApprovalAnswers (repl/engine.ts:67). Nothing outside tests calls createApprovalRequest on run_awaiting_approval. Reactions are not a decision path. |
| 2 | read-auto / write-approval split per company | EXISTS | autonomy-policy.ts evaluateAutonomyPolicy; autonomy-settings.ts:15 defaults (supervised, approvalRequiredForExternalWrites); orchestrator-autonomy-gate.ts; mcp-policy.ts defaultMcpApprovalPolicyForTool; cli seat-wiring.ts TOOLSET_APPROVAL_GATES | — |
| 3 | Multi-level approvals, delegation, escalation timers | PARTIAL | Approval.expiresAt (schema:327); scheduler.ts:269 processExpiredApprovals -> reject + audit + re-plan Task | No escalation to another approver, no chains, no delegation model; gateway only admin/regular tiers |
| 4 | Command allowlist + DM pairing | PARTIAL | gateway/security/PairingManager.ts (default deny, CSPRNG codes, 1h TTL, rate limit, tiers); tools/approval-floors.ts + approval-patterns.ts | No per-sender/tier command allowlist on chat channels |
| 5 | Policy-as-code over traces | PARTIAL | single-call only: mcp-policy, autonomy-policy, external-action-guardrails (pre/post one action), approval-floors floorBlock, seat-capability-gating, credential-boundary scrubSecrets | No cross-call/history rules; governance/ is only IdempotencyManager |
| 6 | PII masking at model gateway | ABSENT | logger.ts REDACT_PATHS (logs only), scrubSecrets (tool output), CredentialBroker (egress) | Prompt-side masking before provider |
| 7 | Human-as-tool / handoff | PARTIAL | critic escalate -> orchestrator.ts:221-232 addCeoMessage; Approval.taskId; TaskStatus waiting_approval/blocked; CeoSuggestion | No explicit ask_human tool; Task has no human assignee/owner/due |
| 8 | Budget warn/stop thresholds | EXISTS | spend.ts:62-65 softWarn 80% / hardStop 100%, assertSpendAvailable, assertAgentTokenBudget, assertToolSpendAllowed; cli repl/budget.ts BudgetLedger alert_thresholds | — |
| 9 | Hash-chained audit + signed export | PARTIAL | audit-log.ts computeAuditHash/verifyAuditChain; api .../audit/verify and .../audit/export (NDJSON) | Export unsigned (no HMAC / chain-head attestation) |

Surprises: approval-floors exists but docs/security.md:190 says it doesn't (stale doc); nonce +
timingSafeEqual on chat approvals; expiry -> re-plan task; MCP tools auto-classified into policy
classes with approve_once; escalation AgentRole; REPL durable approval index via JobRun
type trent_approval; delegated children report `blocked` rather than waiting for humans.
