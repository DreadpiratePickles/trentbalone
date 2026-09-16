# Clusters E (tools/MCP/integrations) + I (team/platform) — audit 2026-09-15

## E
| # | Item | Status | Evidence | Missing |
|---|---|---|---|---|
| 1 | MCP gateway (per-user OAuth, token store, per-tool policy, one endpoint) | PARTIAL | McpServer model (schema:267) credentialRef/toolAllowlist/reversibleTools; mcp-store.ts:133 getMcpServerToken; mcp-policy.ts; mcp-tool-adapter.ts:241; catalog grantMode oauth_user; core egress TokenManager/CredentialBroker | No OAuth for MCP servers (create route static token only, docs/mcp.md:86); tokens per-company never per-user; no single proxy endpoint |
| 2 | Signed/sandboxed MCP, poisoning scan | PARTIAL | mcp-tool-adapter.ts:167 verifyMcpToolIntegrity (rug-pull drift, needs_reapproval); MCP_CALL_TIMEOUT_MS; stdio scrubbed env, http via egress w/ SSRF checks; skills/SecurityScan.ts | No signature verification; no install-time poisoning scan; no OSV preflight for npx; web adapter no output secret redaction; no CPU/mem caps |
| 3 | IntegrationMap + catalog->install | PARTIAL | ToolConnection, McpServer, AgentPlugAssignment, AgentEntitlement, MCP_CONNECTOR_GALLERY, connector-matrix.ts:53, provisioning/ | No {entity,sourceId,internalId} table; api/integrations/route.ts:59 generic install stubbed |
| 4 | Webhooks in/out | PARTIAL | inbound Stripe + Resend only; job-events.ts EventEmitter | Outbound is descriptor-only (surfaces/developer-surfaces.ts:12 createWebhookSurface) — nothing delivers/signs; no generic inbound trigger |
| 5 | Automation rules engine | PARTIAL | schedule-only: RecurringTaskTemplate, scheduler.ts, autonomy-scheduler.ts:72, goal-loop.ts:379, internal-actions.ts:76; JobRun as run log; plug cycles cron | No rule model, no record-change/webhook triggers, conditions, versioning |
| 6 | Trent as MCP server | EXISTS | app/api/mcp/route.ts (stateless streamable-HTTP, API keys w/ mcp / mcp:approve scopes); lib/mcp-server/tools-read.ts, tools-approvals.ts, run-agent.ts:138 trent_run_agent; registry.ts resources+prompts; sanitize.ts | — |
| 7 | Per-end-user OAuth for 3rd-party tools | ABSENT | platform-oauth.ts:180 state companyId only; google-connection.ts:50 OPERATOR_SCOPE; ToolConnection no userId | all |
| 8 | 100+ subagent fan-out | ABSENT | DELEGATE_MAX_TASKS=6 (tools/delegate/index.ts:21); MAX_DELEGATED_STEPS_PER_RUN=6 depth 2; ORC_MAX_CONCURRENCY=4 | no autoresearch mode |

## I
| # | Item | Status | Evidence | Missing |
|---|---|---|---|---|
| 9 | Custom roles / permission toggles | PARTIAL | rbac.ts:3 ROLES 4-rank; CompanyMember.permissions Json + Agent.permissions Json exist | permissions Json never checked — session.ts:75 hardcodes ["*"] |
| 10 | SSO/SCIM/2FA | ABSENT | auth.ts NextAuth Credentials(dev)+Google | all |
| 11 | Guest roles / client portal | PARTIAL | Company.publicVisibility + app/public/[companySlug]; Report; proof-dashboard | No guest role, no invite flow (members only via seed/session), no signed share links |
| 12 | Audit export signed | PARTIAL | api/audit JSON listing; verifyAuditChain | no CSV/download, no signature |
| 13 | Frontend plugin slots | ABSENT | nav-config.ts:38 static; plug schema-v2 tools/seats/cycles/pricing only | all |
| 14 | Draggable dashboard | ABSENT | fixed layouts | all |
| 15 | Importers | PARTIAL | config/migrate.ts own-schema only; setup/detect.ts; company-memory-upload | no Notion/Linear/Jira/CSV; no hermes/openclaw migrate |
| 16 | Agent definition export | PARTIAL | fleet/AgentInstaller.ts:341 <id>.json; skills single .md; seat-manifest.ts:341 | no .af / SKILL.md dir layout (docs/skills.md:96), no export cmd |
| 17 | GDPR export/delete, backup/restore | PARTIAL | api/teardown/confirm; backup-health.ts checkBackupHealth/simulateRestore | no per-company export; BUG backup-health.ts:21 points at pg-restore-test.sh, actual is pg-restore-drill.sh |
| 18 | i18n / white-label / palette | PARTIAL | command-palette.tsx:40, workbench-command-palette, cli slash | no i18n, no white-label |
| 19 | Mobile | ABSENT | — | all (no PWA manifest either) |

Surprises: outbound webhooks are marketing metadata only; CompanyMember.permissions dead column;
Trent-as-MCP-server is complete; MCP rug-pull check real+tested; latent bug backup-health.ts:21.
