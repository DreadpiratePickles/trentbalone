# Contributing to Trent

Thank you for your interest in contributing. This doc covers the essentials for working in this repo.

---

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(agents): add PM agent daily token budget enforcement
fix(ui): repair kill-switch keyboard shortcut on Windows
chore(deps): bump openai to 4.x
docs(readme): add env-var table
```

Types: `feat` · `fix` · `chore` · `docs` · `refactor` · `test` · `perf` · `ci`

---

## PR template

When you open a PR:

1. **Title** — Conventional Commit format
2. **What / Why** — 2–3 sentences
3. **Test plan** — how you verified it
4. **Breaking changes** — if any
5. **Checklist**
   - [ ] `npm run build` passes
   - [ ] `npx tsc --noEmit` passes
   - [ ] Tests added or updated
   - [ ] No secrets committed
   - [ ] Env vars documented in `.env.example`

---

## Dev setup

```bash
npm install
cp .env.example .env.local   # fill in required vars
npx prisma db push
npm run dev
```

See README.md for the full env-var reference.

---

## Branch strategy

- `main` — always deployable
- `feat/<name>` — feature branches
- `fix/<name>` — bug fixes
- `chore/<name>` — non-functional changes

Branch protection: `main` requires a passing CI check and at least one reviewer.

---

## Code style

- TypeScript strict mode — no `any`, no `!.` without justification
- Files ≤ 500 lines; split if longer
- No `console.log` in production paths — use structured logging
- Client components: `"use client"` at top
- Server actions / route handlers: validate all inputs at the boundary

---

## Security

Report vulnerabilities via `security@trent.app` — see [SECURITY.md](SECURITY.md).

Never commit secrets, credentials, or `.env.local` to the repo.

---

## License

MIT — see [LICENSE](LICENSE).
