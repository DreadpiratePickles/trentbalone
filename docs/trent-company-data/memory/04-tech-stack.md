# Trent — Tech Stack & Engineering Conventions

**Upload this to Memory so the Engineer agent follows existing patterns.**

---

## Repository layout

```
trent/
├── app/                          Next.js App Router pages
│   ├── api/                      API route handlers
│   └── companies/[id]/           Company sub-pages
├── components/                   React client components
├── lib/                          Business logic, types, utilities
│   ├── agents/                   Agent runner orchestration
│   ├── provisioning/             Infrastructure provisioners
│   ├── marketing/                Ad campaign management
│   └── social/                   Social media types
├── prisma/                       Schema + migrations
└── docs/                         Internal docs, ADRs, plans
```

## File conventions

- Max 500 lines per file; split if larger
- Co-locate client component with its page: `command/page.tsx` → `command-client.tsx`
- Types live in `lib/types.ts` (shared) or inline if used only in one file
- IDs: always `makeId("prefix")` — never `uuid()` or `Date.now()` as ID
- Timestamps: always `nowIso()` — never `new Date().toISOString()` directly
- Never mutate; return new objects

## API route conventions

```
GET    /api/companies/:id              → company + agents + tasks + cycles
POST   /api/companies/:id/cycles       → trigger cycle
GET    /api/companies/:id/wiki         → wiki aggregate
POST   /api/companies/:id/wiki/search  → RAG search with citations
GET    /api/workbench                  → sessions list
POST   /api/workbench                  → create session
GET    /api/workbench/:id/messages     → transcript
POST   /api/workbench/:id/messages     → send + stream
```

Every route wraps tenant data access in `withRlsContext(companyId, ...)`.

## Agent role mapping

| Role key | Responsibility |
|---|---|
| `ceo` | Strategy, cycle orchestration, briefings |
| `engineer` | Code generation, PR review, testing, deploy |
| `growth` | Ad campaigns, experiment setup, conversion copy |
| `content` | Blog, docs, changelog, release notes |
| `support` | Ticket response, FAQ generation, escalation |
| `analyst` | Metrics, cohort reports, dashboards |
| `finance` | Burn rate, invoices, monthly close |

## Database schema highlights

- `Company` — top-level tenant, all FK chains flow through `companyId`
- `Agent` — one per role per company; holds config + last run status
- `Task` — unit of work; status flows draft→queued→running→completed/failed
- `Cycle` — each daily sweep; contains all tasks for that run
- `Approval` — pending human gate; links to a task that is paused
- `AuditLog` — append-only; every agent write hashes its predecessor
- `UsageLedgerEntry` — cost attribution per task/tool/cycle
- `WbSession` (WorkbenchSession) — a Trenchpad build session
- `WikiNote` — vault note, stored as markdown with metadata

## Security invariants (must never break)

1. `withRlsContext` wraps every route that reads/writes tenant data
2. `checkAuthRateLimit` fails **closed** (returns 429 on Redis outage)
3. `assertToolSpendAllowed` reserves full estimated spend before agent runs
4. `appendAuditLog` uses a serializable transaction — never split the hash-read
5. Secrets decrypted only inside `resolveCredentialEnv`; never logged or passed to LLM prompt directly

## Testing

- Unit tests: Vitest
- Integration tests: hit real SQLite (no mocking the DB)
- E2E: Playwright against localhost
- Coverage target: 80%+
- Run before every commit: `npx tsc --noEmit && npm test`
