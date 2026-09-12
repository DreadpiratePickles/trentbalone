# Product Roadmap

Related: [[architecture]] [[feature-flags]] [[positioning]]

---

## Shipped (Q1 2026)

- [x] Company provisioning (GitHub, Neon, Vercel, R2, Sentry, DNS)
- [x] 7 built-in agent roles
- [x] Daily autonomous cycles
- [x] Approval workflow with inline comments
- [x] Audit log with cryptographic chaining
- [x] Budget guardrails (per-task, weekly, monthly)
- [x] Command chat with 3 modes (Ask / Agent / Autonomous)
- [x] Vault / wiki notes with backlinks and graph
- [x] Memory upload + RAG search

## In progress (Q2 2026)

- [ ] **Workbench / Trenchpad GA** — live build sessions with sandbox preview
  - Streaming plan steps, file writes, terminal output
  - Inline approval before merge
  - Secrets panel
  - ETA: May 30
- [ ] **Agent Marketplace** — third-party agent install
  - Install flow, credit billing, version pinning
  - ETA: June 20
- [ ] **Morning briefing improvements**
  - Personalization (learns what Bobby cares about)
  - Digest format option (bullet vs. prose)
  - ETA: May 15

## Planned (Q3 2026)

- [ ] Mobile app (iOS-first) — approvals and briefings on the go
- [ ] Multi-user companies — invite teammates, role-based access
- [ ] Agent handoff protocol — agents delegate sub-tasks to each other
- [ ] Custom agent builder — build your own agent with a system prompt + tools
- [ ] Trent API — programmatic access to cycles, tasks, approvals

## Parking lot (not committed)

- Notion integration for document sync
- Calendar integration for meeting prep agent
- Voice interface for Command
- White-label offering for agencies

---

## Gate criteria for next release

Before any release to users:
1. All provisioning tests green (133 passing)
2. `npx tsc --noEmit` exits 0
3. E2E flow works: create company → run cycle → approve output
4. No P0 or P1 bugs open
