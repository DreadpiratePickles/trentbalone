# `scripts/ci/` — reproduce every CI job locally

Every job in `.github/workflows/` is a thin wrapper around a command you can run on your own
machine. The point of this file is that **a red build is debuggable without pushing**.

Two jobs are the exception, and they are the whole reason CI exists — see
[What only CI can do](#what-only-ci-can-do).

---

## Ground rules baked into the pipeline

| Rule | Where |
|---|---|
| The gate is `cd apps/web && npm test` (505 files, 2743 tests, exit 0) | `ci.yml` → `web-tests` |
| The **root** `npx vitest run` is misconfigured and is never a gate | see below |
| Node is pinned to `22.x`, the version `apps/web/package.json` declares | `ci.yml` → `env.NODE_VERSION` |
| Bun `1.4.2` for the CLI build and the `bun:sqlite` adapter tests | `ci.yml` → `env.BUN_VERSION` |
| `packages/trent-core/src/store/generated/` is derived, gitignored, regenerated every run, never cached | every job that typechecks or tests core |
| No `secrets: inherit`; each job declares the secrets it needs | `ci.yml` → `live-gate` |
| Every third-party action is pinned to a full commit SHA | all three workflows |
| One required check: **`all-checks-pass`** | `ci.yml` |

### Why the root `vitest run` is banned

`/vitest.config.ts` excludes only top-level `lib/**` and `app/**`, so it sweeps up
`apps/web/**` tests *without* `apps/web/vitest.setup.ts`, without the `next/server` mock alias
and with the wrong cwd. That produces two phantom failures — a collection error in
`apps/web/gbrain/server.test.mjs` and an `ENOENT` on a relative `railway.json` path in
`apps/web/railway.config.test.ts` — neither of which is a product regression. Always run the
workspace scripts, or pass explicit directories:

```bash
npx vitest run packages/trent-core apps/cli   # fine: explicit paths keep the sweep out
npx vitest run                                # BANNED: 2 phantom failures, exit 1
```

### Node version mismatch — known, flagged, not hidden

`apps/web/package.json` declares `engines.node = "22.x"`. The dev machine runs `v26.8.2`. CI
pins the **declared** version because that is the published contract. The consequence is real:
a Node-26-only API will pass locally and fail in CI. Either fix the declaration or match the
machine; do not loosen the pin to make a failure go away.

---

## Reproducing each job

### `detect` — changed-path classification
Nothing to reproduce; it only decides which downstream jobs run. To see what a change would
trigger, read the `filters:` block in `ci.yml`.

### `web-tests` — THE GATE
```bash
npm ci
npm run prisma:generate --workspace=apps/web
cd apps/web && npm test
```
Expected: exit 0, `505 passed | 13 skipped`, `2743 passed | 125 skipped`.

### `web-typecheck`
```bash
cd apps/web && npm run typecheck        # tsc --noEmit -p tsconfig.typecheck.json
```

### `core-typecheck`
```bash
node packages/trent-core/scripts/derive-sqlite-schema.mjs
npx prisma generate --schema packages/trent-core/prisma/schema.sqlite.prisma
npx tsc --noEmit -p packages/trent-core/tsconfig.json
```
The derive step is mandatory: `packages/trent-core/src/store/generated/` is gitignored derived
output, so a fresh clone has none and typecheck fails on missing types until you run it.

### `core-tests`
```bash
node packages/trent-core/scripts/derive-sqlite-schema.mjs
npx prisma generate --schema packages/trent-core/prisma/schema.sqlite.prisma
TRENT_BUN_BIN="$(command -v bun)" npx vitest run packages/trent-core apps/cli
```
`store.durability.test.ts` shells out to a **real Bun binary** because `bun:sqlite` has no Node
equivalent. Without bun on `PATH` or `TRENT_BUN_BIN` set, those tests fail with a message
telling you exactly that — they do not silently skip.

### `lint`
```bash
cd apps/web && npm run lint
```

### `anti-pattern-scan`
```bash
node scripts/ci/repo-scan.mjs                  # strict; exits 1 on any violation
node scripts/ci/repo-scan.mjs --report-only    # triage; always exits 0
node scripts/ci/repo-scan.mjs --only=hex       # one assertion: canned | hex | emoji
bash scripts/ci/assert-no-external.sh
```

Three assertions, each traceable to a real defect:

1. **No canned-string literals.** The previous CLI answered with a pre-written string and its
   only test asserted that string.
2. **No hex colour outside `01_discovery/output/design-tokens.json`.** Only the `color` map is
   authoritative — the `notes` field *names* the forbidden `#8B5CF6` v1 purple and must never
   be read as an allowlist.
3. **No emoji in CLI output.** They break Ink column alignment, corrupt golden frames and
   render as replacement boxes in Windows Terminal.

There is **no baseline/suppression file**, on purpose. A suppression list is how a rule like
this dies.

> **Current state, measured 2026-09-12:** this job FAILS. `398` non-token hex literals across
> `31` files (`#8B5CF6` alone appears in `apps/cli/src/commands/index.ts`, `repl/`, `slash/`
> and every `tui/modals/*` file) and `109` emoji across `21` files. These are pre-existing
> violations in surfaces other agents are actively rewriting, not a defect in the scan. The
> scan was tuned to avoid crying wolf — comment lines that merely *name* a banned literal are
> exempt, and the hard-coded-budget item is deliberately **not** grepped because checklist #14
> is a behavioural proof, not a pattern match.

### `live-gate` / `live-provider-tests`
```bash
node scripts/ci/live-tests-gate.mjs                          # -> skipped, exit 0
TRENT_REQUIRE_LIVE_TESTS=1 node scripts/ci/live-tests-gate.mjs   # no key -> exit 1
```
When no provider key is configured, `live-provider-tests` is `if:`-gated off, so GitHub renders
it **Skipped (grey)** — never Success. An unproven capability must not look proven.
`TRENT_REQUIRE_LIVE_TESTS=1` (set automatically on the nightly schedule and available on
`workflow_dispatch`) inverts this: a missing key then **fails** the gate, so the nightly run
cannot quietly decay into a no-op that still shows green.

The gate only ever reads key **presence**. No value is printed, logged or written to a summary.

### `binaries` (`binary.yml`)
```bash
bash scripts/ci/assert-no-external.sh
bash scripts/ci/build-binary.sh bun-darwin-arm64 dist/binaries/trent-darwin-arm64
node scripts/ci/verify-binary.mjs dist/binaries/trent-darwin-arm64
```
On a Mac you can build **all four** targets and verify exactly **one** of them. That asymmetry
is the point.

### `sandbox` (`sandbox.yml`)
```bash
docker info                       # must exit 0; on the dev machine today it exits 1
npx vitest run packages/trent-core/src/terminal packages/trent-core/src/egress packages/trent-core/src/doctor
```

---

## What only CI can do

Two things, and neither is a matter of convenience — they are capabilities a single Mac does
not have. This is the entire answer to *"do I need a virtual machine?"*: **no, because CI is
already four machines.**

### 1. Running each cross-compiled binary on its real operating system

`bun build --compile` will happily cross-compile from macOS to Linux and Windows and exit 0.
That proves nothing. It is not hypothetical here: a native module in this project
cross-compiled with **exit 0** and produced a **Linux binary containing macOS headers**. The
compile was green; the binary was dead on arrival.

So `binary.yml` builds four artifacts on one runner and then **downloads each one onto its own
native runner and executes it**:

| artifact | built on | RUN on |
|---|---|---|
| `trent-darwin-arm64` | ubuntu-latest | `macos-latest` (Apple silicon) |
| `trent-darwin-x64` | ubuntu-latest | `macos-13` (last Intel-hosted image) |
| `trent-linux-x64` | ubuntu-latest | `ubuntu-latest` |
| `trent-windows-x64.exe` | ubuntu-latest | `windows-latest` |

Each run job asserts, via `scripts/ci/verify-binary.mjs`:
- the artifact starts at all on that OS (no bad-arch / dynamic-loader failure);
- `trent --version` exits 0 and prints a semver;
- `trent doctor --json` emits **one parseable JSON document** with a non-empty `checks` array
  where every entry has a string `status`. `doctor` is allowed a non-zero exit — it exits
  non-zero when a check genuinely fails — but it is not allowed to emit unparseable output,
  and it is not allowed to report zero checks, because "inspects nothing" and "everything is
  fine" look identical from the outside.

On POSIX runners a `file` assertion additionally checks the object headers (`ELF 64-bit` on
Linux, `Mach-O` on macOS) — the specific check that would have caught the macOS-headers-in-ELF
artifact.

`SHA256SUMS` is emitted **only after** every binary has run. Checksumming an artifact nobody
executed just certifies the bytes of a broken binary.

**The `--external` guard.** `scripts/ci/assert-no-external.sh` fails the build if `--external`
appears in any build command — in `build-binary.sh`, `build-cli.sh`, any `package.json`, any
workflow, or in `$TRENT_BUILD_COMMAND` for a command assembled at runtime. That flag previously
produced a binary that compiled cleanly and died at launch, because Ink declares
`react-devtools-core` as a peer dependency npm does not install and a compiled binary has no
`node_modules` to fall back to. If something will not bundle, make it a real dependency or take
it out of the CLI import graph. Comment lines that *mention* the flag are exempt; live code is
not.

### 2. Docker-dependent tests against a real daemon

Measured on the dev machine: `docker --version` → `29.5.3`, exit 0; `docker info` → **exit 1,
daemon not running**. Every Docker-backed suite therefore skips locally, and a suite that only
ever skips is not a suite.

`sandbox.yml` runs on `ubuntu-latest`, which ships a live `dockerd` (so no third-party Docker
action needs pinning or trusting). It first *asserts* the daemon is real — `docker info` plus an
actual `docker run --rm alpine:3.20` — then runs the terminal, egress and doctor suites with
`TRENT_DOCKER_AVAILABLE=1` and `TRENT_REQUIRE_DOCKER_TESTS=1`.

It then does the thing that makes the job worth having: **it fails if anything skipped.** A
green run full of skips on a machine with a live daemon means the gating is wrong, and that
must be a red build rather than a reassuring tick.

---

## Caching policy

- **npm** — `actions/setup-node` with `cache: npm`, keyed on `package-lock.json`. Caches
  `~/.npm` only, never `node_modules`.
- **bun** — handled by `oven-sh/setup-bun`.
- **Never cached:** the Prisma clients. Both `apps/web`'s client and
  `packages/trent-core/src/store/generated/` are regenerated on every job that needs them. A
  cached Prisma client embeds absolute build-machine paths and goes stale against
  `apps/web/prisma/schema.prisma` with no signal that it has — a class of failure that is
  extremely hard to read from a CI log.

## Concurrency

`ci.yml` holds one group per ref, with `cancel-in-progress` **only for pull requests**. Runs on
the default branch are never cancelled: main's run history is the record of what was actually
verified, and a cancelled run leaves a gap in it.

`binary.yml` and `sandbox.yml` deliberately declare **no** concurrency group. They are called by
`ci.yml`, which owns the group; a called workflow sharing its caller's group would deadlock
against it.

## Pinned actions

Every third-party action is pinned to a full commit SHA with the tag in a trailing comment.
A tag is mutable; a SHA is not.

| Action | Tag | SHA |
|---|---|---|
| `actions/checkout` | v4.2.2 | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| `actions/setup-node` | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/upload-artifact` | v4.6.2 | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `actions/download-artifact` | v4.3.0 | `d3f86a106a0bac45b974a628896c90dbdf5c8093` |
| `oven-sh/setup-bun` | v2.0.2 | `735343b667d3e6f658f44d0eca948eb6282f2b76` |
| `dorny/paths-filter` | v3.0.2 | `de90cc6fb38fc0963ad72b210f1f284cd68cea36` |

To bump one, resolve the new tag and replace both the SHA and the comment:

```bash
curl -s https://api.github.com/repos/<owner>/<repo>/git/ref/tags/<tag> | jq -r .object.sha
```

## Validating the workflows before you push

```bash
# YAML parses (the repo already depends on the `yaml` package, so no install is needed)
node -e "const Y=require('yaml'),f=require('fs');\
for(const x of f.readdirSync('.github/workflows'))Y.parse(f.readFileSync('.github/workflows/'+x,'utf8'));\
console.log('all workflows parse')"

# actionlint, without installing anything globally
curl -sL -o /tmp/al.tgz \
  https://github.com/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_darwin_arm64.tar.gz
tar xzf /tmp/al.tgz -C /tmp
/tmp/actionlint -no-color -oneline -shellcheck= -pyflakes= .github/workflows/*.yml
```

`shellcheck` and `pyflakes` are disabled above because neither is installed on the dev machine;
if you have them, drop those two flags to get the embedded `run:` scripts linted too.
