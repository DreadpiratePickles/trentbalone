# Release runbook

Stage `05_release`. How a tag becomes `curl -fsSL https://agent.let-trent.uk/install.sh | bash`,
what is wired, what is blocked, and the exact commands. Written 2026-09-13 against
`DreadpiratePickles/trentbalone` on branch `feature/trent-fleet-v2`; nothing here has been pushed
or released yet.

## The pipeline as built

| Piece | Path | Trigger | Does |
|---|---|---|---|
| Release | `.github/workflows/release.yml` | tag `v*` push, or dispatch with `version` | preflight (tag == `CLI_VERSION` == `apps/cli/package.json`, rendered installers fresh, public keys present, no private key tracked) -> `binary.yml` via `workflow_call` (4 targets built, each RUN natively, `SHA256SUMS`) -> sign (recompute and compare sums; `minisign -S` + `openssl dgst -sign` with the secrets, keys in `$RUNNER_TEMP` under `umask 077` for one step, shredded, asserted gone) -> verify both signatures against the COMMITTED public keys -> publish (re-verify, `render.sh --check`, refuse an existing release, `gh release create v<version>` with binaries, `SHA256SUMS{,.minisig,.sig}`, `install.sh`, `install.ps1`; notes from the annotated tag) |
| Pages | `.github/workflows/pages.yml` | push to `main` touching the installers or the page, `release: published`, dispatch | copies `scripts/install.sh`, `scripts/install.ps1`, `scripts/release/pages/index.html`, writes `CNAME` = `agent.let-trent.uk`, deploys with `configure-pages`/`upload-pages-artifact`/`deploy-pages` (SHA-pinned) |
| Preflight | `scripts/release/preflight.sh` | by hand, before tagging | clean tree, version match, tag free, keys, rendered installers, `gh auth status`, `gh secret list`, no existing release, CI green on HEAD. Tested by `scripts/release/preflight.test.sh` (15 cases, stub `gh`) |
| Version check | `scripts/release/check-version.sh` | release.yml + preflight | single source of the "tag must equal `CLI_VERSION`" rule |
| Key shim | `scripts/release/minisign-plain-key.mjs` | release.yml sign step | see "Finding: the stored minisign key" below |
| Landing page | `scripts/release/pages/index.html` | pages.yml | plain HTML, tokens obsidian/bone/pulse only, no emoji (both enforced in the workflow) |

Permissions: every job is `contents: read` except `publish` (`contents: write`) and the Pages
`deploy` job (`pages: write`, `id-token: write`). No `secrets: inherit`.

## Blockers for a first release, in order

1. **The repository is private, so the one-curl install cannot work for the public.**
   `install.sh` resolves the version from `https://github.com/DreadpiratePickles/trentbalone/releases/latest`
   and downloads from `.../releases/download/v<version>/<asset>`; `trent update` and
   `trent desktop install` use `api.github.com/repos/DreadpiratePickles/trentbalone/releases/latest`.
   All of those answer 404 to anyone without a token while the repo is private, and neither the
   installer nor the updater sends one (by design: the host allowlist and "no credentials" are part
   of the threat model). The workflows will publish fine; nobody outside the repo can download.
   Decide one of:
   - **A. Make the repository public** (recommended: one command, no code change, the updater and
     both installers work as written):
     `gh repo edit DreadpiratePickles/trentbalone --visibility public --accept-visibility-change-consequences`
     Before that: confirm no secret ever entered history (`git log -p -- scripts/installer/keys/ | grep -c 'PRIVATE KEY'`
     must be 0; the private keys are gitignored and untracked today), and that `docs/security.md`
     findings you do not want public are acceptable.
   - **B. Keep the code private, publish releases from a public mirror repo** (for example
     `DreadpiratePickles/trent-releases`). Requires changing `TRENT_REPO` in
     `scripts/installer/install.sh.in` / `install.ps1.in`, `RELEASE_REPO` in
     `packages/trent-core/src/updater/release.ts`, re-rendering the installers, and pointing
     `gh release create --repo` in `release.yml` at the mirror with a PAT secret (`contents: write`
     on the mirror) instead of `github.token`. Also Pages then lives on the mirror. Roughly a day of
     changes plus tests; only worth it if the source must stay closed.
   One-line decision for the user: **choose A unless the source must remain closed; say "public" or "mirror".**
2. **GitHub Pages is not enabled** (`gh api repos/DreadpiratePickles/trentbalone/pages` -> HTTP 404,
   `has_pages: false`). Pages on a *private* repository needs GitHub Pro, Team or Enterprise; on the
   Free plan it is only available once the repo is public (blocker 1A solves this too). The plan
   could not be read with the current token (`gh api user --jq .plan` -> null); check
   <https://github.com/settings/billing>. Enable with source "GitHub Actions" (not done by me; the
   workflow deliberately does not try):
   `gh api -X POST repos/DreadpiratePickles/trentbalone/pages -f build_type=workflow`
   then set the domain: `gh api -X PUT repos/DreadpiratePickles/trentbalone/pages -f cname=agent.let-trent.uk -F https_enforced=true`
   or in the UI: Settings -> Pages -> Source "GitHub Actions"; Custom domain `agent.let-trent.uk`.
   DNS is already right: `agent.let-trent.uk` is a Cloudflare-proxied CNAME that reaches GitHub
   (`curl -sI https://agent.let-trent.uk/install.sh` returns a GitHub 404 with an
   `x-github-request-id`). Because the record is proxied, GitHub cannot issue its own certificate:
   either set Cloudflare SSL mode to "Full" and leave "Enforce HTTPS" off on GitHub, or switch the
   record to DNS-only so GitHub can provision Let's Encrypt. Optionally verify the domain for the
   account (Settings -> Pages -> Add a domain) so no other repo can claim it.
3. **CI has not gone green on a pushed HEAD.** `gh run list` shows the last runs on
   `feature/trent-fleet-v2` cancelled or queued; `preflight.sh` refuses to tag until every check
   run on HEAD completed successfully, and `release.yml` only builds what `binary.yml` proves runs.
   Merge to `main` (the tag must point at a commit CI verified), then tag.
4. **Working tree.** `scripts/release/preflight.sh` on this machine today: 7 pass, 2 fail (dirty
   tree from other in-flight agents; HEAD not pushed). Both are expected to clear on `main`.

## Finding: the stored minisign key prompts real `minisign` for a password

`scripts/installer/keys/README.md` says `minisign` reads `minisign.key` "as generated". It does
not: `gen-keys.mjs` labels the key `Sc` (scrypt) with opslimit 0 while storing the bytes in clear;
minisign 0.12 decides on the label alone, prompted `Password:` and produced no signature
(verified locally, `minisign -S ... < /dev/null`). minisign's own unencrypted layout differs only in
`kdf_alg = "\0\0"`, which the key checksum does not cover. `scripts/release/minisign-plain-key.mjs`
rewrites those two bytes inside `$RUNNER_TEMP` after checking the checksum, and refuses a truly
encrypted key. With that shim the exact README commands sign and `minisign -V` verifies against the
committed `minisign.pub`. The `TRENT_MINISIGN_KEY` secret does not need to change. Longer term:
fix `gen-keys.mjs` to emit `\0\0` (owned outside this stage), then drop the shim.

## Cutting a release

```sh
scripts/release/preflight.sh --version 1.0.0          # must end "ready:"
git tag -a v1.0.0 -m "Trent Fleet 1.0.0

<release notes: these become the GitHub Release body>"
git push origin v1.0.0                                 # triggers release.yml
gh run watch                                           # preflight -> binaries -> sign -> publish
gh release view v1.0.0 --json assets --jq '.assets[].name'
```

Expected assets: `trent-darwin-arm64`, `trent-darwin-x64`, `trent-linux-x64`,
`trent-windows-x64.exe`, `SHA256SUMS`, `SHA256SUMS.minisig`, `SHA256SUMS.sig`, `install.sh`,
`install.ps1`. Then `pages.yml` runs on `release: published`; the deploy job polls
`https://agent.let-trent.uk/install.sh` for two minutes and warns (does not fail) if it is not yet
answering. Verify from a machine with no clone:

```sh
curl -fsSL https://agent.let-trent.uk/install.sh | bash
trent --version && trent doctor --json | head -c 300
```

Rollback: `gh release delete v1.0.0 --cleanup-tag --yes`. The Pages site keeps serving the
installers; they resolve `releases/latest`, which now points at the previous release.

## Desktop bundles (not wired)

`release.yml` has a `desktop` job gated on the repository variable `TRENT_RELEASE_DESKTOP == 'true'`,
which does not exist (`gh api .../actions/variables` -> 0), so it never runs. `apps/desktop` is a
Tauri v2 app: the build needs a Rust toolchain, the Next.js standalone build of `apps/web`, a
vendored Bun per target triple and per-OS bundling into `.dmg`/`.msi`/`.AppImage`, with
`signingIdentity: null` (`docs/desktop.md`). It has only ever built on the developer Mac. That is
not a cheap job and an unverified bundle must not be published. To enable later: a matrix on
`macos-latest`/`macos-13`/`windows-latest`/`ubuntu-latest` running `npm run build` in `apps/desktop`,
asset names exactly `desktopBundleName()` in `packages/trent-core/src/updater/desktop.ts`
(`Trent Fleet_<version>_<aarch64|x64>.dmg` etc.), included in the SAME `SHA256SUMS` before signing,
plus a launch check per OS. Then set the variable.

## What was verified locally (2026-09-13)

| Check | Command | Result |
|---|---|---|
| YAML parses | `node -e 'require("yaml").parse(...)'` on both workflows | OK, jobs listed |
| actionlint + shellcheck | `actionlint -no-color .github/workflows/{release,pages}.yml` (brew, v1.7.12) | exit 0 |
| Scripts lint | `shellcheck -s bash scripts/release/*.sh` | exit 0 |
| Preflight tests | `bash scripts/release/preflight.test.sh` | passed 15, failed 0 |
| Preflight, real repo | `scripts/release/preflight.sh` | 7 pass, 2 fail (dirty tree, HEAD unpushed) |
| Signing dry run | exact workflow step against a temp `SHA256SUMS`, keys copied into `$RUNNER_TEMP` with `umask 077`, real `minisign` 0.12 + OpenSSL 3.6.4 | sign exit 0; 0 key files left afterwards |
| Verification | `minisign -V -p scripts/installer/keys/minisign.pub`; `openssl dgst -sha256 -verify scripts/installer/keys/ecdsa-p256.pub.pem` | both exit 0 |
| Updater verifier | `npx tsx` calling `verifyArtifact()` from `packages/trent-core/src/updater/verify.ts` with the embedded `TRENT_RELEASE_PUBLIC_KEY` | OK, key `95449402BB103CCE` |
| Tamper | one byte appended to `SHA256SUMS` | `minisign -V` exit 1; `verifyArtifact` throws |
| Page tokens | hex colours in `index.html` | only `#0A0A0F #6EE7B7 #F1ECE2` |
| Action SHAs | `gh api repos/actions/<x>/git/ref/tags/<tag>` | configure-pages v6.0.0, upload-pages-artifact v5.0.0, deploy-pages v5.0.1 resolved and pinned |

Not verified: the workflows have not run on GitHub (nothing pushed); Windows PowerShell installer
not executed; `apt-get install minisign` on `ubuntu-latest` assumed available from universe.
