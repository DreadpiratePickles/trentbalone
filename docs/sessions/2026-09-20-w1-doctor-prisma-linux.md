# 2026-09-20 — W1: `trent doctor --json` dies on the Linux RUN job (Prisma engine)

Branch `feature/trent-fleet-v2`, base 7243f91. No commit made; files left in the working tree.

## Failure
`binaries / RUN trent-linux-x64 on ubuntu-latest` fails from f403127 on (also ff036d4), passes at
60ca092; darwin-arm64, darwin-x64 and windows pass on the same commits with 20 checks. The step's
own log: `trent doctor --json` exit 1, stdout 0 bytes, stderr `PrismaClientInitializationError:
Prisma Client could not locate the Query Engine for runtime "debian-openssl-3.0.x"` ending in
`Bun v1.4.2 (Linux x64)`: an unhandled rejection killed the process before the report was written.

## Root cause (evidence, not inference)
- `checkAppMemory` (`packages/trent-core/src/doctor/checks/app-memory.ts`, since 241ec38) probes
  the app's store by `import("@/lib/store")` on every profile. Every module exporting that store,
  `@/lib/mem-store` included (24 modules, measured with Bun's registry), evaluates
  `apps/web/lib/db.ts:8` `new PrismaClient()`.
- Prisma's LibraryEngine constructor (bundle line 28975) runs
  `this.libraryInstantiationPromise = this.instantiateLibrary()` with no handler. A query would
  await it (`start()`, bundle 29076) and catch the failure; with no `DATABASE_URL` the app uses its
  in-process store (`store.ts:11`), so no query ever reaches the client and nothing handles it.
- On the build machine Prisma finds the engine through the baked absolute path
  `/Users/bobbymeher/Desktop/trent/node_modules/.prisma/client` (it is in the searched list), so
  the promise resolves there. On any other machine it rejects after platform detection.
- f403127 appended `checkMedia` after `checkAppMemory` (`DoctorRunner.ts:83-84`). Its
  `mediaImagePresent` (`tools/media/backend.ts:183`) spawns `docker inspect` whenever `docker` is
  on PATH: true on ubuntu-latest, false on the macOS and Windows runners (no `docker`, and
  `findOnPath` does not try `.exe`). Those ~300 ms are the window the rejection needed. With 19
  checks `checkAppMemory` was last and `apps/cli/src/index.ts:51` `process.exit` came first.
- `orchestrator/libs.ts` and `resume.ts` were cleared: `loadLibs` imports are all dynamic inside
  the function; `resume.ts` imports only `errors` and types.
- Reproduced: HEAD `trent-linux-x64` in `ubuntu:24.04`, empty `TRENT_HOME`, a `docker` shim on
  PATH that sleeps 0.3 s and exits 1 -> exit 1, stdout 0 bytes, same stack. Same binary without
  the shim -> exit 3, 20 checks. Same binary with the shim and `DATABASE_URL=file:...` -> exit 3
  (the probe's query attaches the handler). `foundry.ts:69-75` records the same failure shape from
  an earlier static import of `@/lib/db`.

## Change
- `packages/trent-core/src/doctor/checks/app-memory.ts`: with `DATABASE_URL` unset or "" (the
  app's own truthiness test) the check answers from `store.ts:11` without loading the app's store;
  with a database configured it still measures through one `listDocuments` read. Header explains
  why the in-process case must not be probed.
- `packages/trent-core/src/doctor/app-store-isolation.test.ts` (new): `vi.doMock` guards on
  `@/lib/store`, `@/lib/db` and `@prisma/client` record every evaluation in the worker's graph;
  asserts the single check and the whole `DEFAULT_CHECKS` run never evaluate them on an empty
  profile, that "" behaves like unset, and that a configured database still imports the store and
  reads once. RED before the fix: 3 failed / 2 passed (`loaded` was `["@/lib/store"]`; "" reported
  as a durable server store). GREEN after: 5/5.
- `docs/doctor.md` row 18 says the store is not loaded when `DATABASE_URL` is unset or empty.

## Verification (clean worktree of ff036d4 + these three files; ff036d4..HEAD is docs only)
- `npx vitest run packages/trent-core/src/doctor packages/trent-core/src/orchestrator packages/trent-core/src/wrapped-modules.test.ts` -> exit 0, 33 files, 217 tests.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
- `npm --prefix packages/trent-core run build` -> exit 0.
- `node scripts/ci/repo-scan.mjs` -> exit 0.
- `cd apps/cli && npm run build:binary -- darwin-arm64` -> exit 0; `TRENT_HOME=$(mktemp -d)
  TRENT_QUEUE_FALLBACK=disabled dist/trent-darwin-arm64 doctor --json` from a `node_modules`-free
  cwd -> exit 3, 20 checks, stderr 0 bytes; `node scripts/ci/verify-binary.mjs` on it -> exit 0.
- Linux, the failing scenario: rebuilt `trent-linux-x64` with the fix, `ubuntu:24.04`, docker
  shim on PATH, empty home -> exit 3, 20 checks, stderr 0 bytes; with `DATABASE_URL=file:` -> exit
  3. `scripts/ci/verify-binary.mjs` in `node:22` with the shim -> exit 0, all six PASS.
- In the shared working tree the same vitest command shows 1 failed test + 1 failed file, both
  from concurrent tasks: `checks/business.test.ts` imports a `business.js` that does not exist yet
  (W2), and `checks/media.test.ts`'s `media_image` case (W4). Not touched here.

## Found, not fixed (outside W1)
- `trent run "say hi" --json` from the Linux binary on an empty profile (no key, no model call)
  fails after 1.5 s with `the run ended without a verdict` and the same Prisma engine error on
  stderr, exit 1. The durable profile's `file:` URL routes every app-store call to the postgres
  Prisma client, whose engine is not shipped; the run itself, not only the memory tiers, ends on it.
  Needs its own investigation on a non-build machine.
