# 2026-09-15 — Feature backlog decision (from ~/Downloads/trent-todo.txt research)

Goal: Bobby ran a peer survey (ever-gauzy + 18 ERP/PM peers + AI-agent-platform peers) in another
session and produced a ~90-item backlog. Task: decide which items to include in Trent without
duplicating what already exists, and write that decision down.

## Method
- The research was written against the web app alone; the branch now has `packages/trent-core`
  (Hermes toolsets, cron, messaging gateway, fleet memory, egress, GEPA/improve loop) which covers
  a lot of it. So: audit every backlog item against the real code first, with file evidence.
- Five Opus Explore agents, one per cluster (runtime / HITL+policy / observability+memory /
  tools+platform / work+money+CRM+channels). Each reports EXISTS / PARTIAL / ABSENT per item.
- Then synthesize into `02_plan/output/feature-backlog-decision.md`.

## Steps
- (in progress) audit agents launched.
- Cluster B audit landed -> 02_plan/output/audit/cluster-b-hitl.md
- Cluster E/I audit landed -> 02_plan/output/audit/cluster-e-i-tools-platform.md (bugs found: backup-health.ts:21 wrong script name; CompanyMember.permissions dead column; outbound webhook surface is descriptor-only)
- Cluster F/G/H/J audit landed -> 02_plan/output/audit/cluster-f-g-h-j-work-money-crm-channels.md (bugs: gateway start no agentHandler; voice STT stub; sequences.ts steps[0]; Task/Goal/Cycle disconnected)
- Cluster A and C/D audits landed -> 02_plan/output/audit/ (bugs: CLI cron has no runner + unregistered; quiet-hours.ts unused; OTelExporter never instantiated; IdempotencyManager unwired; SSH/E2B CLI backends are mock strings)
- All five audits in. Tally over 74 audited items: 8 EXISTS, 49 PARTIAL, 17 ABSENT.
- Wrote `02_plan/output/feature-backlog-decision.md`: phase 0 (12 truth fixes: gateway drops
  chat messages, chat approvals don't resume runs, cron has no runner, OTel exporter never built,
  voice stub is a canned string, SSH/E2B backends are mocks, IdempotencyManager unwired,
  quiet-hours unused, backup-health wrong script, stale security doc, dead permissions column,
  sequences bug), then phases 1 autonomy (cron runner, HEARTBEAT.md loop, gateway push alerts,
  sleep-time memory consolidation), 2 conversation model (threads=sessions, double-texting policy,
  reactions as approvals, ask_human tool), 3 trust (class-level trace policy rules, prompt
  redaction, MCP install scan + output scrub, signed audit export, per-company caps + DLQ view),
  4 fleet lifecycle (AgentVersion on the improve ledger, export/import format, N memory blocks),
  5 work graph + webhooks (needs Bobby: touches apps/web schema — invariant 1).
- Refused with reasons: ERP/finance/CRM/HR domain, SSO/roles/GDPR/i18n/mobile stage, web-UI items
  (plugin slots, dashboards, Kanban/Gantt, PQL, custom fields), 100+ fan-out, outbox, rules engine,
  IntegrationMap, per-user OAuth, importers, approval chains, time-travel fork, voice, device nodes.

## Evidence
- Audit tables: `02_plan/output/audit/cluster-{a,b,c-d,e-i,f-g-h-j}*.md` — file:line per claim.
- No code changed this session. Nothing run beyond `ls`/`cat`/`grep`.

## Left open
- Bobby's call on §6 (phase 5 / invariant 1). Phases 0–4 need no new authorization.
- Next session: start phase 0 at 0.1 (gateway agentHandler) — failing wire test first.
