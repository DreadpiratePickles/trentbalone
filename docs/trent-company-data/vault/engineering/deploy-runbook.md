# Deploy Runbook

Related: [[architecture]]

---

## Prerequisites

- Vercel CLI installed: `npm i -g vercel`
- `.env` at `/Users/bobby/Desktop/en/trent.env.rtf` — never commit
- `GITHUB_TOKEN` and `SECRET_ENCRYPTION_KEY` are production credentials
- Both databases migrated: `trent.db` AND `trent-test.db`

---

## Standard deploy

```bash
# 1. Type check first — always
npx tsc --noEmit

# 2. Run tests
npm test

# 3. Push to main (CI runs on Vercel automatically)
git push origin main
```

Vercel preview deployments are created on every branch push.
Production deploys only from `main`.

---

## Database migrations

After any Prisma schema change:

```bash
# Push to local dev DB
npx prisma db push --schema=prisma/schema.prisma

# Push to test DB
DATABASE_URL="file:./trent-test.db" npx prisma db push

# Generate client
npx prisma generate
```

For production Neon:
```bash
npx prisma migrate deploy
```

---

## Environment variables (required)

| Variable | Where |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `NEXTAUTH_SECRET` | Random 32-byte string |
| `NEXTAUTH_URL` | https://trent.app |
| `ANTHROPIC_API_KEY` | Anthropic console |
| `OPENAI_API_KEY` | OpenAI console |
| `SECRET_ENCRYPTION_KEY` | Generated, stored in 1Password |
| `GITHUB_TOKEN` | GitHub App token |
| `UPSTASH_REDIS_REST_URL` | Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash console |

---

## Rollback

If a deploy breaks production:

```bash
# Roll back in Vercel dashboard (one click)
# OR: revert the commit and push
git revert HEAD
git push origin main
```

For DB migrations: Prisma does not auto-rollback. Run the inverse migration manually or restore from Neon branch.

---

## Monitoring

- **Vercel dashboard** — build logs, function logs, edge errors
- **Sentry** — runtime errors per company (DSN injected per-company via env-manager)
- **PostHog** — product analytics, feature flag state
- **Upstash console** — queue depth, Redis stats

---

## Smoke test after deploy

1. Sign in at https://trent.app
2. Open the Trent company dashboard → Console loads
3. Click "Run cycle" → job appears in Queue → completes
4. Open Command → send "status check" → response streams back
5. Open Vault → at least one page renders
