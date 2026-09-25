# P2-A1 release path: public key in git, durable clone, no manual queue export (2026-09-25)

Wave P2 agent A1 (Opus, no subagents, no commits). Scope from the lead: `.gitignore`,
`scripts/installer/**`, `.github/workflows/ci.yml`, root `package.json` and `apps/cli/package.json`
scripts, `apps/cli/src/index.ts` (entry only) plus a tiny preload module beside it, the install doc
(`docs/getting-started.md`; there is no `docs/install.md`), one note in
`05_release/output/release-runbook.md`, and this log. Source: `05_release/output/public-readiness-audit-2026-09-25.md`
fixes 2, 5, 6 and the "first release would fail" finding (section 1.3). HEAD 7eb7502, branch
feature/trent-fleet-v2; other agents edit the tree concurrently (README.md, apps/cli/src/commands/**,
apps/cli/src/repl/**, packages/trent-core/src/** are theirs). Every shell: `TRENT_QUEUE_FALLBACK=disabled`
exported, vitest from the repo root, except where a step deliberately unsets it.

## Discovery (before any change)
- `.gitignore` ignores `*.pem` TWICE: line 35 (secrets block) and line 52 (OS/IDE block). Git takes
  the LAST matching pattern, so a negation must sit after line 52. `git check-ignore -v
  scripts/installer/keys/ecdsa-p256.pub.pem` -> `.gitignore:52:*.pem` (exit 0 = ignored).
- `scripts/installer/keys/.gitignore` separately ignores `minisign.key` and `*.key.pem`; a deeper
  `.gitignore` wins over the root one, so the private ECDSA half stays ignored whatever the root says.
- Readers of the public key: `render.sh:35` (exit 2 if absent), `release.yml:98` (`test -s`),
  `release.yml:107` and `pages.yml:89` (`render.sh --check`). `ci.yml` never runs `render.sh`, and its
  `detect` filters do not cover `scripts/installer/**`.
- `TRENT_QUEUE_FALLBACK` is read at CALL time in `apps/web/lib/queue.ts:203`
  (`shouldRunFallbackProcessor`), and by the doctor's `assertStandaloneEnv` at run time. No module
  reads it at load time, but the default goes in a first-imported preload module anyway so a future
  load-time reader cannot slip ahead of it (ESM evaluates static imports in order).
- The SQLite store client: `packages/trent-core/prisma/schema.sqlite.prisma` is committed (derived,
  `prisma-client` generator, output `../src/store/generated`, gitignored). The generate command is the
  one CI and `scripts/dev/isolate.sh:12` use: `prisma generate --schema packages/trent-core/prisma/schema.sqlite.prisma`.
  `prisma` 6.19.3 is an `apps/web` dependency hoisted to the root `node_modules/.bin`.
- Which store is in use is reported by `trent improve status --json` (`store.durable`, plus `reason`
  when not durable; `apps/cli/src/commands/improve-sweep.ts:146-183`) and `trent jobs failed --json`
  (`durable`). The doctor's Database check reports the `trent.db` file, not the store kind.
- No doc promises a Bun script name (`grep -rn "cli:bun\|bun --no-env-file" docs README.md`: only
  `docs/troubleshooting.md:192` names `bun --no-env-file`), so the script is `cli:bun` as the audit proposes.

## Log

### (1) ECDSA public key kept out of git — RED on a clean worktree
- `openssl pkey -pubin -in scripts/installer/keys/ecdsa-p256.pub.pem -noout -text | head -3` ->
  `Public-Key: (256 bit)` / `pub:` / `04:f6:02:...` (exit 0); the file is `-----BEGIN PUBLIC KEY-----`
  .. `-----END PUBLIC KEY-----`, `grep -c PRIVATE` = 0. It is the public half and nothing else.
- Why committing it discloses nothing: the committed installer already embeds it byte-for-byte.
  `git show HEAD:scripts/install.sh | sed -n 104,107p | diff - scripts/installer/keys/ecdsa-p256.pub.pem`
  -> no output (identical): `scripts/install.sh:104-107` is the PEM inside `ECDSA_PEM="$(cat <<'PEM'`
  (`:103`), and `scripts/install.ps1:98` carries its X||Y point (`$EcdsaXY`). Both are served to every
  installer user by design; a public key's whole job is to be known.
- Clean worktree: `git worktree add --detach $SCRATCH/p2a1-wt HEAD` (exit 0, 7eb7502, 0 changes;
  `ls scripts/installer/keys/` has no `ecdsa-p256.pub.pem`).
  - `sh scripts/installer/render.sh --check` -> `render.sh: keys/ecdsa-p256.pub.pem missing`, **exit 2**
  - `test -s scripts/installer/keys/ecdsa-p256.pub.pem` (release.yml:98) -> **exit 1**
  - `git check-ignore -v scripts/installer/keys/ecdsa-p256.pub.pem` -> `.gitignore:52:*.pem`, exit 0 (ignored)

### (1) GREEN
- `.gitignore`: after the second `*.pem` (old line 52) added `!scripts/installer/keys/ecdsa-p256.pub.pem`
  with a four-line comment (why it is safe; must stay after the last `*.pem`).
  - `git check-ignore -v scripts/installer/keys/ecdsa-p256.pub.pem` -> `.gitignore:57:!scripts/installer/keys/ecdsa-p256.pub.pem`
    (the negation is now the deciding rule); `git check-ignore -q` on it -> exit 1 (not ignored);
    `git status --short` -> `?? scripts/installer/keys/ecdsa-p256.pub.pem` (committable).
  - Private halves unchanged: `git check-ignore -v .../ecdsa-p256.key.pem` -> `scripts/installer/keys/.gitignore:3:*.key.pem`;
    `.../minisign.key` -> `scripts/installer/keys/.gitignore:2:minisign.key`. Every other `*.pem` in the
    tree (outside node_modules) is still ignored.
- `.github/workflows/ci.yml`: new job `installer-render` (checkout, no install; unconditional because
  `detect` has no installer filter and a stale render can come from any path) with two steps copied from
  release.yml's preflight: public keys present / private keys not tracked, then
  `sh scripts/installer/render.sh --check`. Added to `all-checks-pass.needs`.
  YAML: every file under `.github/workflows/` parses with the repo's `yaml` package (exit 0 each;
  PyYAML is not installed here, `import yaml` -> ModuleNotFoundError).
- Clean worktree AFTER (copied only `.gitignore` and the public key in; `git status` there:
  ` M .gitignore`, `?? .../ecdsa-p256.pub.pem`): the two CI step bodies, extracted from ci.yml and run
  -> exit 0 and exit 0; `render.sh --check` -> **exit 0**; `test -s .../ecdsa-p256.pub.pem` -> **exit 0**.
- Staging note for whoever commits: stage exactly `.gitignore scripts/installer/keys/ecdsa-p256.pub.pem
  .github/workflows/ci.yml`; `git ls-files 'scripts/installer/keys/*.key*'` must stay empty.

### (2) Durable clone — RED then GREEN on the same clean worktree
Throwaway `HOME` and `TRENT_HOME` under the scratchpad for every CLI run; no provider key in the env.
- RED, HEAD's `package.json` (no postinstall): `npm install --no-audit --no-fund` -> exit 0, 12 s;
  `ls packages/trent-core/src/store/generated` -> No such file or directory.
  `bun --no-env-file apps/cli/src/index.ts improve status --json` -> exit 0,
  `{"store":{"durable":false,"reason":"bun:sqlite unavailable under this runtime (Cannot find module './generated/client' imported from .../packages/trent-core/src/store/createStore.ts)"}}`.
  Same profile, `doctor --json` Database line: `warn`, `No database file at .../trent.db; nothing has been persisted yet.`
  (The `reason` blames bun:sqlite although Bun is the runtime and the missing piece is the generated
  client: `apps/cli/src/commands/improve-sweep.ts:160`, another agent's file. Reported, not changed.)
- Change: root `package.json` gains
  `"postinstall": "prisma generate --schema packages/trent-core/prisma/schema.sqlite.prisma --no-hints"`
  (the command CI, binary.yml, sandbox.yml and `scripts/dev/isolate.sh:12` already run; it reads the
  committed derived schema, so it writes only the gitignored `src/store/generated/`) and
  `"cli:bun": "bun --no-env-file apps/cli/src/index.ts"` (`--no-env-file` per `docs/troubleshooting.md:192`).
- npm records a root install script in the lockfile: `npm install` in the worktree added exactly
  `"hasInstallScript": true` to `packages[""]` of `package-lock.json` (blob 16cd54c -> f70fe86). The
  same one line is applied in the main tree (byte-identical blob f70fe86), otherwise every developer's
  first `npm install` would leave a dirty lockfile. `npm ci` with the OLD lockfile and the new
  package.json also works (exit 0, runs the postinstall, writes nothing), so CI does not depend on it.
- npm 11.19 blocks DEPENDENCY install scripts not in `allowScripts` (8 listed as warnings, e.g.
  `@prisma/engines`, `esbuild`), but runs the ROOT project's own `postinstall`: the output shows
  `> trent-fleet-monorepo@1.0.0 postinstall` and `✔ Generated Prisma Client (6.19.3) to ./packages/trent-core/src/store/generated in 190ms`.
- Quiet: `--no-hints` drops Prisma's tips. Prisma's update box (`Update available 6.19.3 -> 8.0.0-rc.17`)
  can still appear once its checkpoint cache says so; only an env var (`PRISMA_HIDE_UPDATE_MESSAGE` /
  `CHECKPOINT_DISABLE`) hides it, and a `VAR=1 cmd` prefix would make `npm install` fail outright under
  Windows cmd. Kept cross-platform; three lines of output is the cost.
- GREEN: `rm -rf node_modules packages/trent-core/src/store/generated`, `npm install --no-audit --no-fund`
  -> exit 0, 12 s, postinstall generated the client, lockfile unchanged beyond the one line.
  `npm run --silent postinstall` again -> exit 0, `git status` unchanged (idempotent).
  `npm run --silent cli:bun -- improve status --json` -> exit 0, **`{"store":{"durable":true}}`**, and
  `$TRENT_HOME/trent.db` (1134592 bytes) + `-shm` + `-wal` exist.
  `npm run --silent cli:bun -- doctor --json --timeout 3000` -> exit 3 (no key, as expected); its
  Database line: `ok`, **`SQLite integrity_check ok, journal_mode wal (.../p2a1-home-after/t/trent.db).`**
  Under Node (`npm run --silent cli -- improve status --json`) it stays `durable:false` (`Received protocol 'bun:'`):
  durability is a Bun property, which is what the docs now say.
- Process note: to restore the worktree's lockfile once I ran `git checkout -q HEAD -- package-lock.json`
  INSIDE the scratch worktree (never in the shared tree); later restores used `git show HEAD:<f> > <f>`.

### (3) No manual TRENT_QUEUE_FALLBACK export — RED then GREEN
- Test first: `apps/cli/src/__tests__/env-defaults.test.ts` spawns the real entry
  (`node --import tsx apps/cli/src/index.ts doctor --json --timeout 2000`) with ONLY `PATH`, a
  throwaway `HOME`/`TRENT_HOME`, `TMPDIR` and `NO_COLOR` (so no NODE_ENV=test, no key, no Redis URL
  leak in from vitest) and reads the doctor's result for the check whose name `checkEnvironment.name`
  exports. Three cases: unset -> ok; empty string -> ok; `enabled` -> fail with a
  `TRENT_QUEUE_FALLBACK ...` violation (the default must never override a user's explicit value).
- RED: `npx vitest run apps/cli/src/__tests__/env-defaults.test.ts` -> exit 1, `2 failed | 1 passed (3)`,
  both failures `expected 'fail' to be 'ok'` (the right reason); the explicit-value case passed already.
- Change: new `apps/cli/src/env-defaults.ts` (one statement: set `disabled` when the variable is
  unset OR empty; an empty value enables the app's fallback exactly like an unset one, since
  `queue.ts:203` compares `!== "disabled"`), imported as the FIRST import of `apps/cli/src/index.ts`.
  Deviation from the brief's `??=`: `??=` would leave `TRENT_QUEUE_FALLBACK=` (empty) double-executing.
- GREEN: same command -> exit 0, `3 passed (3)` (~0.6 s per spawn).
- Audit acceptance (main tree, throwaway HOME/TRENT_HOME, no key; doctor exits 3 for the missing key
  and Docker, as before): `env -u TRENT_QUEUE_FALLBACK npm run --silent cli -- doctor --json` ->
  Environment `{"status":"ok"}`; same via `npm run --silent cli:bun --` -> `{"status":"ok"}`;
  `TRENT_QUEUE_FALLBACK=enabled npm run --silent cli -- doctor --json` -> `{"status":"fail","violations":["TRENT_QUEUE_FALLBACK must be \"disabled\"; ..."]}`.
- Compiled binary (the release artifact; built on the clean worktree = HEAD + this change):
  `bash scripts/ci/build-binary.sh bun-darwin-arm64 $SCRATCH/p2a1-bin/trent` -> exit 0 (85079538 bytes);
  `env -i PATH=... HOME=... TRENT_HOME=... trent doctor --json` -> Environment `{"status":"ok"}`;
  with `TRENT_QUEUE_FALLBACK=enabled` -> `fail`. Bun's bundler kept the preload first.

### Docs (users no longer told to export)
- `docs/getting-started.md` (the install doc; there is no `docs/install.md`): bun row and note; section 2
  says `npm install` generates the store client and adds "Durable state needs Bun" (`npm run cli:bun`);
  section 3's capture note; section 4 rewritten (nothing to export; still unset the Redis/eval-queue
  variables; never set another value); section 8 lists `npm run cli:bun --`.
- `docs/troubleshooting.md`: "Every job runs twice" now says the CLI defaults the variable and the fix
  is to remove an explicit value at its source; the bun section; a new entry for
  "From a clone, the REPL says `This session is not durable`".
- `docs/doctor.md`: one sentence under the 2026-09 transcript (its env failure predates the default).
- Left alone on purpose: `docs/configuration.md:961-986` (states the requirement, tells no one to
  export; another agent is editing that file), `docs/mcp.md:199,212` (generated MCP client config,
  harmless), `docs/desktop.md:13` (the desktop sets it itself).
- `05_release/output/release-runbook.md`: blocker 5 (the key was never in git; how to stage it; why
  `preflight.sh` check 4 cannot see an untracked key).

### Verification (main tree unless marked ISOLATED = clean worktree at 7eb7502 + only these changes)
| Command | Exit |
|---|---:|
| `npx vitest run apps/cli/src/__tests__ packages/trent-core/src/wrapped-modules.test.ts apps/cli/src/commands/__tests__/docs-truth.test.ts` | 0 (3 files, 17 tests) |
| same + `apps/cli/src/commands/__tests__/audit.test.ts` (spawns the entry under Bun), ISOLATED | 0 (4 files, 27 tests) |
| `npx vitest run apps/cli --reporter=dot`, ISOLATED | 0 (85 files, 1434 passed, 1 skipped) |
| `npx tsc --noEmit -p apps/cli/tsconfig.json`, main tree | 2: 8 errors, all in other agents' in-flight `commands/__tests__/behaviour.test.ts` (4, `SetupSummary.reason`) and untracked `commands/__tests__/service.test.ts` (4, missing `../groups/service.js`); 0 name my files |
| `npx tsc --noEmit -p apps/cli/tsconfig.json`, ISOLATED | 0 |
| `node scripts/ci/repo-scan.mjs` (main and ISOLATED) | 0, 0 |
| `bash -n scripts/installer/render.sh` | 0 |
| `scripts/installer/render.sh --check` (main; ISOLATED) | 0; 0 |
| every `.github/workflows/*.yml` through the repo's `yaml` parser (`parseDocument`, errors = 0) | 0 x5 |
- Worktree removed: `git worktree remove --force $SCRATCH/p2a1-wt` -> exit 0. HEAD moved to 4c05f65
  meanwhile (three commits by other agents); `git diff --name-only 7eb7502 HEAD` touches none of my files.

### Files changed (nothing staged, nothing committed)
Modified: `.gitignore`, `.github/workflows/ci.yml`, `package.json`, `package-lock.json` (one line,
see (2)), `apps/cli/src/index.ts`, `docs/getting-started.md`, `docs/troubleshooting.md`,
`docs/doctor.md`, `05_release/output/release-runbook.md`.
New: `scripts/installer/keys/ecdsa-p256.pub.pem` (now committable; content unchanged),
`apps/cli/src/env-defaults.ts`, `apps/cli/src/__tests__/env-defaults.test.ts`, this log.
Commit hint: the ci.yml job goes red on any commit that lacks the key, so `.gitignore`,
`scripts/installer/keys/ecdsa-p256.pub.pem` and `.github/workflows/ci.yml` belong in one commit.

### Handoffs (other owners' files; not edited)
- README owner: `README.md:33` (`export TRENT_QUEUE_FALLBACK=disabled`: delete); `README.md:83-85`
  (says it "must be exported for `trent doctor` to pass": now false); `README.md:107-109` (durable
  store claim: true only under Bun, now `npm run cli:bun --`, client generated by `npm install`).
  Draft `05_release/output/README-draft-2026-09-25.md:50` (export), `:54` proof comment ("Without the
  export the doctor adds a failure"), `:70-78`, commands at `:75-76` (the manual `prisma generate` is now done by
  `npm install`; the alias can be `npm run --silent cli:bun --`).
- `apps/cli/src/commands/improve-sweep.ts:160` and `apps/cli/src/repl/index.ts:299`: the not-durable
  reason says "bun:sqlite unavailable" / "needs Bun" even when Bun is running and the generated client
  is what is missing.
- `packages/trent-core/src/doctor/checks/environment.ts:42` fixHint still opens "Export
  TRENT_QUEUE_FALLBACK=disabled"; still correct advice for an explicit bad value, could say "unset it".
- `scripts/release/preflight.sh:56` (check 4) tests the working tree only; `git ls-files --error-unmatch`
  on the public keys would make it see an untracked key on a developer machine.
- Root `npm run build:binary` still does not exist (`docs/getting-started.md:298` in "Not yet
  implemented", `README.md:142`); not in this brief.
