# 2026-09-12 — Fleet manager defect fixes (test-first)

Scope: `packages/trent-core/src/fleet/**` only. No git operations. No changes to `apps/web/`,
`apps/cli/`, `.github/`, or any other `packages/trent-core/src/*` directory.

## RED first

New/expanded tests written and watched fail before any fix (15 failures across 3 files):

| # | Defect | RED failure |
|---|---|---|
| 1 | Core roles invisible in `getStatus()` | `expected 164 to be 173`; installed `ceo` -> `expected undefined to be defined` |
| 2 | No security scan, no skill install | `installed.installed_skills is not iterable`; refusal test: `expected function to throw an error, but it didn't` |
| 3 | `FLEET_PACKS.all` mislabelled | `expected 9 to be 164` |
| 4 | `findAgent` fuzzy `name.includes` | `expected undefined to be an instance of TrentError` (query `architect` silently resolved one of several) |
| 5 | `dailyBudgetSpent` hard-coded 0.0 | `expected undefined to be +0`; `fleet.recordSpend is not a function` |

Plus RED for: idempotent reinstall (`installed_at` rewritten), `budget_cap_per_run` (undefined cents),
uninstall (no skill removal; returned `true` for an agent that was never installed).

## GREEN

- `SkillProvisioner.ts` (new). Two-phase `plan`/`commit`: every skill body is resolved from
  `apps/web/.agents/skills/<slug>/SKILL.md` and passed through `SecurityScan` **before** the first
  write, so a refused install leaves nothing behind. Source is injectable (`SkillSource`).
- `FleetUsage.ts` (new). Durable keyed ledger at `<profile>/fleet-usage.json`, integer cents, UTC
  day buckets, 90-day retention. Ingests per-message `cost_cents` from `SessionStore`, keyed
  `session:<id>:<messageId>`, so re-reading never double counts.
- `AgentInstaller.ts`. Exact id/name/prefixed-id wins; substring search resolves only a unique
  candidate and otherwise throws `TrentError` listing the candidates. Install is idempotent
  (preserves `installed_at`, no duplicate config entries or skill files). `budget_cap_per_run_cents`
  comes from `budget.per_run_cap` or the core role's own `budgetCapCents`; the old dollars field
  survives as a derived deprecated view. Uninstall deletes the record plus skills no other installed
  agent references, and returns `false` when there was nothing to remove.
- `FleetPacks.ts`. `all` now holds all 164 catalog ids (label kept); the nine core roles moved to a
  new `core-roles` pack.
- `FleetManager.ts`. `listAgents()` returns 9 core roles + 164 specialists with a `kind` field;
  `getStatus()` exposes `dailyBudgetSpentCents` / `dailyBudgetCapCents` (dollars views deprecated,
  derived); `installPack` throws with the failures named instead of silently installing fewer agents.

## Evidence

```
npx vitest run packages/trent-core/src/fleet      -> 32 passed / 3 files, exit 0
npx tsc --noEmit -p packages/trent-core/tsconfig.json -> exit 0
```

## Observations for other owners (not fixed here)

- `src/config/defaults.ts` seeds `fleet.installed_agents` with `["ceo", "eng-ai-engineer",
  "support-responder"]` before anything is on disk, and `support-responder` is not a real id
  (`sup-support-responder` is). Tests here blank the fleet in `beforeEach` to work around it.
- `apps/web/.agents/skills/obsidian-second-brain/SKILL.md` contains a `curl ... | bash` install line
  that the scanner flags. No catalog agent references that slug today, so no install is blocked.
