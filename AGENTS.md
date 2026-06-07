# Trent — Codex Context

> **This is `trent-os`** — a clean copy of the Trent app (no `node_modules`, `.next`, `.git`, build artifacts, or `.env`) set up to be built with the [Superpowers](https://github.com/obra/superpowers) methodology.

## ⚡ Superpowers Methodology (use it)

This project follows obra/superpowers. The 14 skills are installed at `.Codex/skills/`. Before any build work:

1. Read `.Codex/skills/using-superpowers/SKILL.md`.
2. Follow the loop: `brainstorming` → `using-git-worktrees` → `writing-plans` → `subagent-driven-development` (+ `test-driven-development`) → `requesting-code-review` → `verification-before-completion` → `finishing-a-development-branch`.
3. The build plans live in `docs/superpowers/plans/`:
   - `2026-05-28-trent-os-master-plan.md` — 15-phase sequencing, gates, and the per-phase superpowers loop.
   - `2026-05-28-phase-0-foundation-hardening.md` — worked bite-sized TDD example slice (RBAC). Copy this format for every new slice.
4. Source-of-truth scope: `../03-task-list.md` (advisor-readable) and `trent-master-tasklist.md` (canonical).

## ⚡ Start Every Session By Reading These Files

```
/Users/bobby/Documents/obsidian/trent/README.md          ← project overview + tech stack
/Users/bobby/Documents/obsidian/trent/tasklist-summary.md ← what's done, what's open, priorities
/Users/bobby/Documents/obsidian/trent/context.md          ← codebase patterns + key files
/Users/bobby/Documents/obsidian/trent/plan.md             ← superpowers implementation plan
/Users/bobby/Documents/obsidian/trent/session-log.md      ← what was done last session
```

## After Each Session

Append a new entry to `/Users/bobby/Documents/obsidian/trent/session-log.md` with what was built.

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER commit secrets or .env files
- ALWAYS run `npx tsc --noEmit` before committing
- After Prisma schema changes: push to BOTH `trent.db` AND `trent-test.db`
- Files under 500 lines; split if larger
- Use `makeId("prefix")` for IDs, `nowIso()` for timestamps

## Security

- `.env` at `/Users/bobby/Desktop/en/trent.env.rtf` — NEVER commit this
- `GITHUB_TOKEN`, `SECRET_ENCRYPTION_KEY` are real production credentials

## Master Task List

Full tasklist: `/Users/bobby/Desktop/running-v/trent/trent-master-tasklist.md`
Condensed: `/Users/bobby/Documents/obsidian/trent/tasklist-summary.md`
