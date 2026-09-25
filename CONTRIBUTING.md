# Contributing

Trent is built under one rulebook: [docs/development_methodology_and_coding_rulebook.md](docs/development_methodology_and_coding_rulebook.md).
[AGENTS.md](AGENTS.md) holds the invariants every change must keep. This page is the part of both a
contributor needs on day one.

## Set up

Node 22 or newer and npm. From the repository root:

```bash
npm install
export TRENT_QUEUE_FALLBACK=disabled   # AGENTS.md, "standalone environment contract"
npm run cli -- doctor                  # what is missing on this machine
```

[docs/getting-started.md](docs/getting-started.md) goes from there to a first conversation, with or
without a model key.

## The rules

1. **Failing test first.** Write the test, run it, and watch it fail for the reason the change is
   about (not a missing import, not a timeout in the harness). Then the smallest change that makes it
   pass. A test that asserts a hard-coded string is not a test, and a test is never weakened, skipped
   or deleted to make code pass; a changed requirement is written down first.
2. **No claim without a command and its exit code.** "Looks right" is not evidence. A pull request
   says what it ran and what came back.
3. **Isolate before you commit.** `scripts/dev/isolate.sh <test paths...> -- <files...>` copies only
   the named files onto a clean worktree of `HEAD` and runs the CLI typecheck, the core build, the
   repo scan and the named tests. Commit only on `ISOLATED rc=0`. It is how a change is proven to stand
   on its own when the working tree holds other work ([scripts/dev/README.md](scripts/dev/README.md)).
4. **Stage explicit paths.** `git add path/one path/two`, never `git add .` or `git add -A`. Small
   commits, one change each.
5. **Files stay under 500 lines.** A file nearing 400 is a prompt to split it by responsibility.
6. **Docs tell the truth, and a test checks.** `apps/cli/src/commands/__tests__/docs-truth.test.ts`
   reads the README, getting-started, configuration and security pages and fails on a command,
   subcommand, config key, slash command or doctor check count the code does not have. Change the
   docs in the same commit as the behaviour.
7. **`apps/web/` is read-only.** Wrap it in `packages/trent-core/`; do not edit it. The one exception
   is a deliberate bug fix in its own commit, with a test.
8. **Secrets never enter code, tests, logs, commits, issues or chat.** Say where a secret lives, never
   its value. Tests use obvious fakes.
9. **Nothing leaves the machine without the maintainer.** Contributors open pull requests; pushing to
   shared branches, merging, tagging and publishing are the maintainer's.

## Run the suites

All from the repository root, with `TRENT_QUEUE_FALLBACK=disabled` exported:

```bash
npx vitest run packages/trent-core apps/cli     # the CLI and core suites (what CI runs)
npx vitest run apps/cli/src/repl                # or any narrower path while you work
npx tsc --noEmit -p apps/cli/tsconfig.json      # CLI typecheck
npx tsc --noEmit -p packages/trent-core/tsconfig.json
cd packages/trent-core && npm run build         # core build
node scripts/ci/repo-scan.mjs                   # no canned replies, no invented colours, no emoji
cd apps/web && npm test                         # the wrapped application's own gate
```

Tests named `*.live.test.ts` call real providers. They skip when no key is present, and most also
wait for `TRENT_TEST_LIVE=1` (`npm run test:live`). A skipped live test is not a passing one.

## Pull requests

Fill in the template: the failing test and its first red line, the `ISOLATED rc=0` line, the
docs-truth run, and a statement that no secret is in the diff. Bugs and ideas go in issues, using
the templates. Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md); security reports
follow [SECURITY.md](SECURITY.md).
