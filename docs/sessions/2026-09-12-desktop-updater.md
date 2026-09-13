# 2026-09-12 — `trent desktop` + real updater (agent session)

Scope: `packages/trent-core/src/updater/**` rebuilt; `apps/cli/src/commands/desktop.ts` new;
`apps/cli/src/commands/index.ts` registration. Nothing committed.

- RED first: 43/43 failing on missing exports across 4 files, then implemented.
- Minisign verified with `crypto.verify` (Ed25519, "ED" prehashed BLAKE2b-512 via `createHash("blake2b512")`),
  no shell-out, no vendored parser. Format documented in `minisign.ts` from jedisct1.github.io/minisign.
- Public key embedded verbatim from `scripts/installer/keys/minisign.pub` (key id 95449402BB103CCE);
  `publicKey.test.ts` fails if the constant and the file ever differ. Private key location:
  `scripts/installer/keys/minisign.key` (gitignored) — value never read.
- Verification: `npx vitest run packages/trent-core/src/updater apps/cli/src/commands` -> 6 files, 315 tests, exit 0.
  Typecheck: zero errors in owned files; pre-existing errors in gateway/orchestrator/repl/tui untouched.
- Live `update --check` / `desktop status` exit 5: api.github.com returns 404 for the repo (no release yet).
- Dead code left for the owner: `updateSpec` in `groups/maintenance.ts` is no longer imported.
