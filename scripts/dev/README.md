# Commit isolation helpers

Used by the orchestrating session to commit one task at a time while several agents edit the
shared working tree. Never `git stash` under running agents.

- `isolate.sh <test paths...> -- <files...>`: makes (or resets) a detached worktree of HEAD under
  `$TRENT_DEV_SCRATCH` (default `/tmp/trent-dev`), copies the named files from the working tree
  onto it (`published/path=source/path` copies a variant instead), regenerates the SQLite Prisma
  client, then runs `tsc`, the core build, `repo-scan` and the given vitest paths. Gate a commit on
  `ISOLATED rc=0` in its output; the full vitest log is at `$TRENT_DEV_SCRATCH/wt-vitest.log`.
- `cutblocks.py <file> <out> "<marker line>"`: HEAD's version of a config file plus only the
  working-tree regions that start with that marker (`// [task] ...`), import regions after the
  last import, key regions before `personality:`. `BASE=<file>` chains onto another variant.
- `hunks.py <file> <out> <regex>...`: HEAD's version plus only the `git diff -U0` hunks whose lines
  match a regex (adjacent insertions merge into one hunk, so prefer cutblocks for marked blocks).
- `dropblocks.py <file> <out> <marker>...`: the working-tree version minus the marked regions.
- `regen-snapshot.mjs`: run with `npx tsx` inside the worktree after copying a config change;
  rewrites `packages/trent-core/src/config/schema-split.snapshot.json` (every commit that adds a
  config key must include the regenerated snapshot).

A task's config block must be one contiguous region starting with `// [task] <title>` placed
immediately before the `personality:` key (or, for a nested key, inside its section file under
`config/sections/`, which cutblocks cannot place; do that by hand).
