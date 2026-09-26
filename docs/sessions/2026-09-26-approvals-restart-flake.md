# 2026-09-26 — approvals.restart CI flake (`Cannot find module './internal/class'`)

Scope: find what rewrites `packages/trent-core/src/store/generated` during a vitest run, pin it with a
failing test, fix it minimally. No subagents (lead's instruction). Load average ~380: reasoning from
code first, only targeted vitest invocations.

## Log (appended as I go)

- Read AGENTS.md, rulebook §11 and Phases 4-6, harness-landscape log "Known CI flake, unsolved".
- Writer found by reading code: `packages/trent-core/src/store/derive-sqlite-schema.test.ts` runs
  `scripts/derive-sqlite-schema.mjs` twice (beforeAll, and the idempotency test); the script's
  line 155 runs `prisma generate --schema prisma/schema.sqlite.prisma`, whose output is
  `../src/store/generated`, the SAME directory every Bun child imports. It also rewrites
  `prisma/schema.sqlite.prisma`, `prisma/init.sql` and `src/store/derived-ddl.ts` in place.
- Prisma 6.19.3 `prisma-client` generator (node_modules/prisma/build/index.js, minified `ayt` and
  `rEe`): first unlinks every `**/*.{js,ts,...}` under the output dir, then for each top-level
  entry `fs.rm(entry, {recursive:true, force:true})` then mkdir/writeFile. So during a generate
  `generated/internal/class.ts` (150 KB) is absent while `client.ts` may already be back: exactly
  Bun's "Cannot find module './internal/class' from .../generated/client.ts".
- Why "it happened inside the exclusive project" is not an alibi: vitest 3.2.7 types
  `fileParallelism` as a NonProjectOptions key (`ProjectConfig = Omit<InlineConfig,
  NonProjectOptions ...>`, node_modules/vitest/dist/chunks/reporters.d.BuRON0I0.d.ts:2347-2348),
  and the forks pool is ONE Tinypool sized from the ROOT config (`createForksPool`,
  coverage.DfSpMS-b.js:2608-2631); the only per-project knob it reads is
  `poolOptions.forks.singleFork` (:2674-2675). So the "exclusive" project's `fileParallelism:
  false` is silently dropped: its six files run concurrently with each other and with the
  parallel project. derive-sqlite-schema.test.ts (a writer) and approvals.restart.test.ts (a
  reader) are both in it and do overlap.
- Ruled out as writers: apps/cli durability/store-durability tests (vi.mock the store module, no
  disk writes); createStore.test.ts (mocks node:fs reads only); CI (generates before vitest, once);
  scripts/dev/isolate.sh (dev only, not run by tests).
- CI timeline (attempt-1 logs of runs 36191653032/7eb7502, 36194277396/a23efa5, 36217278037/5989ac8;
  jobs 108257994441, 108266915277, 108336057865). The default reporter prints a file when it ends.
  derive-sqlite-schema.test.ts starts at (end - file duration); its second derive (the idempotency
  test) starts at (end - that test's duration); so the first derive (beforeAll) ends just before.
  | commit  | Bun child died  | 2nd derive starts   | gap    | reader's project |
  |---------|-----------------|---------------------|--------|------------------|
  | 7eb7502 | 21:30:37.956    | 42.736-4.673=38.063 | 107 ms | parallel         |
  | a23efa5 | 22:02:35.198    | 40.082-4.772=35.310 | 112 ms | parallel         |
  | 5989ac8 | 04:21:59.413    | 04.391-4.905=59.486 |  73 ms | exclusive        |
  Three for three, the Bun child dies in the last ~100 ms of the first derive run, i.e. inside its
  final step, `prisma generate` (script line 155). In 5989ac8 the reader and the writer are BOTH
  in the "exclusive" project and overlapped, which is direct proof that project is not serial;
  parallel-project files also report throughout that window.
- Probe: `prisma generate` with schema and output under the scratchpad (no node_modules above it)
  works, exit 0; note it then emits `.ts` import suffixes (Prisma reads the nearest tsconfig; the
  in-repo client and CI's are extensionless). Irrelevant to the fix: the generated client is
  gitignored and the test never compares it.
- RED, in an isolated scratch mini-repo (copies of the test, the script, both schemas, init.sql,
  derived-ddl.ts, the generated client; node_modules symlinked). Not in the real checkout: other
  agents run Bun-spawning suites in this working tree, and the current test is the very writer that
  kills them. Pin test added to the CURRENT test file: snapshot inode+mtimeNs of
  generated/client.ts, generated/internal/class.ts, prisma/schema.sqlite.prisma, prisma/init.sql,
  src/store/derived-ddl.ts before the first derive; assert unchanged at the end.
  `vitest run --root <mini> --config <mini>/vitest.config.mjs packages/trent-core/src/store/derive-sqlite-schema.test.ts`
  -> exit 1, 1 failed | 10 passed. The diff: class.ts ino 96823350 -> 96824957, client.ts ino
  96823421 -> 96824949 (deleted and recreated); the three committed files same ino, new mtime
  (truncated and rewritten in place). Red for the right reason.
- Mechanism proof (scratch copy only): a poller (existsSync loop, 4.7 M polls) on the copy's
  generated dir during three `prisma generate` runs saw a hole each time, i.e. client.ts present
  with internal/class.ts absent, for 1.99, 44.22 and 10.86 ms. A Bun loop importing the client in
  parallel did not land in a hole (Bun start-up under load ~0.3 s vs a 2-44 ms hole: why CI flakes
  rarely). Deterministic half: in a copy with internal/class.ts removed,
  `bun -e "await import('<copy>/client.ts')"` -> exit 1, "error: Cannot find module
  './internal/class' from '<copy>/client.ts'", Bun v1.4.2: byte-for-byte CI's message.
- Decision: fix the WRITER, not the scheduler. The derive script gains `--out-root <dir>` (default
  unchanged: the package), and the test derives into a mkdtemp root. That removes the only in-run
  writer whatever vitest does, and also protects other checkouts' concurrent runs in one tree.
  Not chosen: (a) `poolOptions.forks.singleFork` for the exclusive project (would genuinely
  serialize it, but runs its six files after the whole parallel pool in ONE process and leaves the
  writer in place; a separate hypothesis for the lead); (b) a private client copy for the Bun
  child (the child lives in apps/cli/src/repl, owned by an in-flight wave, and the three other
  Bun-spawning suites would still be exposed); (c) retrying in the child (hides the writer).
- FIX: `packages/trent-core/scripts/derive-sqlite-schema.mjs` takes `--out-root <dir>` (no args:
  unchanged, the package; any other argv: throws a usage error before writing anything).
  `packages/trent-core/src/store/derive-sqlite-schema.test.ts` derives into a mkdtemp root (removed
  in afterAll); every old assertion reads the root; new: the committed schema, init.sql and
  derived-ddl.ts equal a fresh derivation byte for byte (keeps the drift signal the in-place
  rewrite used to give via `git status`); the client is generated under the root; an unknown
  argument is refused; and, LAST, the pin: the five shared files keep inode and mtime.
- GREEN (real repo): `npx vitest run packages/trent-core/src/store/derive-sqlite-schema.test.ts`
  -> exit 0, 14 passed (17.1 s under load ~380).
- Writer + reader together (real repo): `npx vitest run packages/trent-core/src/store/derive-sqlite-schema.test.ts
  apps/cli/src/repl/__tests__/approvals.restart.test.ts --reporter=default --reporter=json` -> exit 0,
  17 passed. From the JSON (first-test start / last-test end) and the file durations: both files
  began ~00:59:35.9, approvals.restart's Bun children ran 00:59:35.9-00:59:40.2 wholly inside the
  derive test's first derivation (00:59:36.0-00:59:55.0): the "exclusive" project ran its two files
  concurrently here too. store/generated/client.ts and internal/class.ts kept inode 93606920 /
  93606996 and their Sep 20 mtime across both runs.
- Default path (what CI's "Derive the SQLite schema" steps and developers run) verified in the
  scratch mini-repo with the NEW script, no args: exit 0, prints the usual three lines, regenerates
  that copy's own package client (class.ts mtime advanced), and its schema/init.sql/derived-ddl.ts
  are byte-identical to the committed ones. Not run in the real tree on purpose (it is the writer).
- Typecheck of the changed test alone with the core compiler options (scratch tsconfig extending
  packages/trent-core/tsconfig.json, typeRoots at the repo's @types): `npx tsc --noEmit -p <scratch>/tsconfig.one.json`
  -> exit 0. `node --check packages/trent-core/scripts/derive-sqlite-schema.mjs` -> exit 0. The
  whole-project tsc was not run (load ~380; other waves' in-flight edits would mix in).

## Outcome
Root cause: the derive test regenerated the shared Prisma client in place during the run, Prisma
6.19.3 deletes each output file before rewriting it, and the "exclusive" vitest project that was
meant to keep writer and readers apart is not serial in vitest 3.2.7 (`fileParallelism` is a
non-project option; the shared forks pool ignores it). Fixed at the writer.

Files changed: `packages/trent-core/scripts/derive-sqlite-schema.mjs`,
`packages/trent-core/src/store/derive-sqlite-schema.test.ts`, this log.

Open for the lead (not changed here, separate hypothesis): `vitest.config.ts` EXCLUSIVE project.
Its comment ("file parallelism OFF", "Serial, they never overlap", the Bun transpile-cache theory
of 68894ea) is false, and its derive-sqlite-schema rationale is now stale. Either set
`poolOptions: { forks: { singleFork: true } }` on that project (the per-project knob the pool
reads, coverage.DfSpMS-b.js:2674; those files then run one at a time in one fork after the
parallel pool drains) if desktop.test.ts's hdiutil really needs exclusivity, or drop the project.

## Follow-up (lead, 06:20Z): the EXCLUSIVE project made truthful
Decision: `EXCLUSIVE` keeps only `apps/cli/src/commands/__tests__/desktop.test.ts` (hdiutil is serial on macOS);
the project uses `poolOptions: { forks: { singleFork: true } }`, which vitest 3.2.7 honours per project
(`reporters.d.BuRON0I0.d.ts:2352-2355`; the runner splits singleFork files at `coverage.DfSpMS-b.js:2674-2675`
and runs them in one worker after the parallel files, :2697-2708), instead of `fileParallelism: false`, which is
not a project option (:2347-2348) and was silently ignored. The derive-sqlite-schema test and the four Bun-child
tests return to `parallel` (the writer is fixed above; the Bun-cache theory is disproven). Pinned by
`apps/cli/src/commands/__tests__/vitest-config-truth.test.ts`: red on the old config (exit 1: 3 failed / 1 passed:
six files in the include, `singleFork` undefined, five files still excluded from parallel), green after (exit 0,
4 passed). Each moved file alone: desktop 16 passed (DMG mount ran, hdiutil present), derive-sqlite-schema 14,
approvals.restart 3, store.durability 10, all exit 0. `npx vitest list --project exclusive --filesOnly` prints the
one file. `npx tsc --noEmit -p apps/cli/tsconfig.json` exit 0.
