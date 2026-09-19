# Release checklist, v1.0.0

The ordered steps that turn `feature/trent-fleet-v2` into
`curl -fsSL https://agent.let-trent.uk/install.sh | bash`. Written 2026-09-18 for task E2 against
`.github/workflows/{release,binary,pages,ci}.yml`, `scripts/installer/`, `scripts/release/`,
`scripts/installer/keys/README.md` and `05_release/output/release-runbook.md`. Reconciled on
2026-09-18 (task F0): the six places those sources used to disagree are settled, and "One source per
question" at the end names the one file that answers each.

**Nothing in this file has been run.** Plan decision 9: the release is cut after Phases A and B
land; the checklist is prepared before then. Every step that leaves this machine is a user gate
(`05_release/CONTEXT.md`, "Approval").

## How to read the labels

| Label | Meaning |
|---|---|
| **BOBBY** | Needs a human: a decision, a credential, a DNS or visibility change, or a push. Nothing else can do it, and nothing should try. |
| **BOBBY RUNS** | A human types the command, but nothing outside this machine changes. Safe to repeat. |
| **AUTOMATED** | CI does it with no input. Listed so the evidence it produces is known in advance. |

No step here prints a private key. Where a signing key is involved the command names a **path**
(`scripts/installer/keys/minisign.key`, gitignored, mode 0600 — `scripts/installer/keys/README.md`),
never a value.

---

## Phase 0 — prerequisites that block everything (steps 1-7)

### 1. Phases A and B are landed and green on `main` — BOBBY

Decision 9 gates the release on this, not on a date. Evidence: the wave rows of
`02_plan/output/implementation-plan-hermes-parity.md` closed, and `cd apps/web && npm test` exit 0
(`AGENTS.md`, "Verification gate").

### 2. Choose public repository or public mirror — BOBBY

The one-curl install cannot work while the repository is private: `install.sh` resolves
`https://github.com/DreadpiratePickles/trentbalone/releases/latest` and `trent update` /
`trent desktop install` call `api.github.com/repos/DreadpiratePickles/trentbalone/releases/latest`
(`scripts/installer/install.sh.in:43-45`, `packages/trent-core/src/updater/release.ts:22`). Neither
sends a token, by design. All of those answer 404 to the public today.

Runbook recommendation: **A, make the repository public**, unless the source must stay closed, in
which case B (a public mirror) costs roughly a day of changes plus tests. Say "public" or "mirror".

### 3. Confirm no secret is in git history — BOBBY RUNS

```sh
git log -p -- scripts/installer/keys/ | grep -c 'PRIVATE KEY'    # must print 0
git ls-files scripts/installer/keys/minisign.key scripts/installer/keys/ecdsa-p256.key.pem
```

Evidence: `0`, and the second command prints nothing. A non-zero count means step 4 publishes a
private key; rotate first (`node scripts/installer/keys/gen-keys.mjs --force`, re-render, re-commit)
and do not proceed.

### 4. Make the repository public — BOBBY

```sh
gh repo edit DreadpiratePickles/trentbalone --visibility public --accept-visibility-change-consequences
```

Evidence: `gh repo view DreadpiratePickles/trentbalone --json visibility` prints `PUBLIC`. Also
re-read `docs/security.md`, "Reported, not fixed", and decide those findings are acceptable in the
open — this step publishes them.

### 5. Enable GitHub Pages with source "GitHub Actions" — BOBBY

`pages.yml` deliberately does not try to create the site (`pages.yml:8-12`). Pages on a private
repository needs Pro/Team/Enterprise; step 4 removes that constraint on the Free plan.

```sh
gh api -X POST repos/DreadpiratePickles/trentbalone/pages -f build_type=workflow
gh api -X PUT  repos/DreadpiratePickles/trentbalone/pages -f cname=agent.let-trent.uk -F https_enforced=true
```

Evidence: `gh api repos/DreadpiratePickles/trentbalone/pages` returns 200 with
`"build_type": "workflow"` and the CNAME set (it returned HTTP 404 / `has_pages: false` when the
runbook was written).

### 6. Settle the certificate for `agent.let-trent.uk` — BOBBY

DNS already reaches GitHub: the name is a Cloudflare-proxied CNAME and
`curl -sI https://agent.let-trent.uk/install.sh` returns a GitHub 404 with an `x-github-request-id`.
Because the record is proxied, GitHub cannot issue its own certificate. Pick one:

- Cloudflare SSL mode **Full**, and leave "Enforce HTTPS" **off** on GitHub; or
- switch the record to **DNS-only** so GitHub provisions Let's Encrypt, then turn Enforce HTTPS on.

Optionally verify the domain under Settings -> Pages so no other repository can claim it.
Evidence: `curl -sI https://agent.let-trent.uk/` completes a TLS handshake with no warning.

### 7. Put the signing keys in the release job's secret store — BOBBY

The private halves live at `scripts/installer/keys/minisign.key` and
`scripts/installer/keys/ecdsa-p256.key.pem` on the developer machine, mode 0600, gitignored. They
move into repository secrets and the local copies are removed once CI has signed once
(`scripts/installer/keys/README.md`, "Private keys — where they must live").

```sh
gh secret set TRENT_MINISIGN_KEY --repo DreadpiratePickles/trentbalone < scripts/installer/keys/minisign.key
gh secret set TRENT_ECDSA_KEY    --repo DreadpiratePickles/trentbalone < scripts/installer/keys/ecdsa-p256.key.pem
```

Evidence: `gh secret list --repo DreadpiratePickles/trentbalone` lists both names (names only; the
values are never readable again, which is the point). The key bytes never appear in a terminal, a
log, this file or a chat transcript.

---

## Phase 1 — local preflight (steps 8-11)

### 8. Merge to `main` and let CI go green on the merge commit — BOBBY

The tag must point at a commit CI verified; `preflight.sh` refuses to tag otherwise, and
`release.yml` only signs what `binary.yml` proved runs.

Evidence: `gh run list --workflow CI --branch main --limit 1` shows `completed / success` on the
merge SHA.

### 9. Optional local hygiene: audit the profile the release is cut from — BOBBY RUNS

```sh
trent security audit --json
```

Evidence: exit 0. This checks the operator's own profile, not the artefact — it is here because
step 4 makes this machine's habits public, and a credential sitting in `config.yaml` (which is
written 0644) is the cheapest way to leak one. See `docs/security.md`, "Auditing a profile".

### 10. Run the release preflight — BOBBY RUNS

```sh
scripts/release/preflight.sh --version 1.0.0
```

Nine checks: clean tree; version == `CLI_VERSION` == `apps/cli/package.json`; tag free; public keys
committed and private keys untracked; `scripts/install.sh` / `install.ps1` match a fresh render; `gh`
authenticated; both repository secrets present; no existing release; every check run on HEAD
completed successfully.

Evidence: the last line is `ready: git tag -a v1.0.0 ...`. On this machine on 2026-09-13 it was
7 pass / 2 fail (dirty tree from in-flight agents, HEAD unpushed); both clear on `main`.

### 11. If the render check failed, re-render and commit — BOBBY RUNS

```sh
sh scripts/installer/render.sh && git add scripts/install.sh scripts/install.ps1 && git commit
```

Evidence: `sh scripts/installer/render.sh --check` exits 0. The rendered installers are what Pages
serves and what the release carries; a stale render fails `release.yml` preflight, `pages.yml` build
and `publish` alike.

---

## Phase 2 — tag, build, sign, publish (steps 12-17)

### 12. Tag and push — BOBBY

```sh
git tag -a v1.0.0 -m "Trent Fleet 1.0.0

<release notes: this message becomes the GitHub Release body>"
git push origin v1.0.0
gh run watch
```

The annotated tag's message is the release body (`release.yml:263`); a lightweight tag gets the
one-line default `Trent Fleet v1.0.0`. Evidence: a `Release` run appears on the tag ref.

### 13. `Release / preflight` — AUTOMATED

Resolves the version from the tag, requires semver, requires the tag to point at the commit being
released, runs `scripts/release/check-version.sh`, asserts both public keys are present and neither
private key is tracked, and runs `render.sh --check`.
Evidence: job green; the log line `releasing v1.0.0 (prerelease=false) from <sha>`.

### 14. `Release / binaries` (`binary.yml`) — AUTOMATED

Four targets compiled with `bun build --compile`
(`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-windows-x64`), each artifact then
**downloaded onto its native OS and executed** (`file` check plus
`node scripts/ci/verify-binary.mjs`), and only then `sha256sum trent-* > SHA256SUMS`.

Evidence: artifacts `trent-darwin-arm64`, `trent-darwin-x64`, `trent-linux-x64`,
`trent-windows-x64.exe` and `SHA256SUMS`; four green `RUN <artifact> on <os>` jobs. A binary that
does not launch never reaches the sign job — compile success is not evidence.

### 15. `Release / sign SHA256SUMS` — AUTOMATED (needs step 7)

Recomputes the sums and refuses if they differ from the ones `binary.yml` verified; writes both
private keys into `$RUNNER_TEMP` under `umask 077` for the duration of one step; runs
`scripts/release/minisign-plain-key.mjs` over the minisign secret — a byte-exact pass-through for a
key generated since `e65d88a`, a two-byte `kdf_alg` rewrite for one captured before it, and a
refusal for a genuinely password-protected key; signs:

```
minisign -S -s "$RUNNER_TEMP/minisign.key" -m dist/release/SHA256SUMS -x dist/release/SHA256SUMS.minisig
openssl dgst -sha256 -sign "$RUNNER_TEMP/ecdsa-p256.key.pem" -out dist/release/SHA256SUMS.sig dist/release/SHA256SUMS
```

then shreds the keys, asserts they are gone, and verifies **both** signatures against the COMMITTED
public keys. Evidence: the `Assert the private keys are gone` step green, and the verify step
printing minisign's trusted-comment line plus `Verified OK` from OpenSSL. A failure here means the
secrets do not match the keys the installers embed, and nothing is uploaded.

### 16. `Release / publish` — AUTOMATED

Re-verifies both signatures and `sha256sum --check`, re-renders the installers, refuses to overwrite
an existing release, then `gh release create v1.0.0 --verify-tag`. The only job with
`contents: write`.

Evidence: `$GITHUB_STEP_SUMMARY` lists the assets.

### 17. Confirm the asset list — BOBBY RUNS

```sh
gh release view v1.0.0 --json assets --jq '.assets[].name'
```

Expected, exactly nine: `trent-darwin-arm64`, `trent-darwin-x64`, `trent-linux-x64`,
`trent-windows-x64.exe`, `SHA256SUMS`, `SHA256SUMS.minisig`, `SHA256SUMS.sig`, `install.sh`,
`install.ps1`.

---

## Phase 3 — serve the installer (steps 18-19)

### 18. `Pages` runs on `release: published` — AUTOMATED

Its `gate` job runs first (`scripts/ci/pages-release-gate.mjs`): it lists the repository's releases
and deploys only if a published, non-draft, **non-prerelease** release exists, because
`install.sh` resolves `releases/latest` at run time. Step 16 has just created one, so the gate
opens. Before step 16 — a merge to `main` that touches `scripts/install.sh`, for instance — `build`
and `deploy` are skipped (grey) and the job summary says why; that is the workflow refusing to
advertise an install that would 404, not a failure. To publish the site early for the domain or the
certificate (steps 5-6), dispatch `Pages` with `allow_without_release: true`.

It then re-checks the render, runs `sh scripts/install.sh --manifest` as the installer's own self-check,
refuses a landing page with a colour outside obsidian/bone/pulse or any 4-byte UTF-8 sequence,
assembles `_site` with `install.sh`, `install.ps1`, `index.html`, `CNAME` and `.nojekyll`, and
deploys. The deploy job then polls `https://agent.let-trent.uk/install.sh` for two minutes and
**warns rather than fails** if it is not yet answering.

Evidence: the `github-pages` environment shows the deployment URL; the final step prints
`https://agent.let-trent.uk/install.sh answers`, or the warning, in which case do step 19 by hand
after DNS/CDN propagation.

### 19. Confirm the domain serves the installer — BOBBY RUNS

```sh
curl -fsSI https://agent.let-trent.uk/install.sh | head -1
curl -fsSL https://agent.let-trent.uk/install.sh | sh -n /dev/stdin && echo "parses"
```

Evidence: `HTTP/2 200`, and the script parses in a plain `sh`. Never advertise a URL that is not
serving (`05_release/CONTEXT.md`, "Failure Behavior").

---

## Phase 4 — smoke test, one machine per platform (steps 20-24)

Each of these needs a machine with **no clone, no Node and no Bun**. A binary that fails on its
target is pulled from the release, not documented as a caveat.

### 20. macOS arm64 and macOS x64 — BOBBY

```sh
curl -fsSL https://agent.let-trent.uk/install.sh | bash
trent --version
trent doctor --json | head -c 300
trent security audit --json   # exit 0 on a fresh profile
```

Evidence: the installer prints the verification method it used (`minisign (Ed25519)` where minisign
is installed, otherwise `openssl (ECDSA P-256 co-signature)` on stock macOS, whose LibreSSL cannot
do Ed25519 — this is exactly why the second key exists), `trent --version` prints `1.0.0`, and
`trent doctor` reports.

### 21. Linux x64 — BOBBY

Same commands. Evidence: verification method `minisign (Ed25519)` or
`openssl (Ed25519, minisign format)`.

### 22. Windows x64 — BOBBY

```powershell
irm https://agent.let-trent.uk/install.ps1 | iex
trent --version
```

Evidence: install completes and `trent --version` prints `1.0.0`. The runbook's "Not verified" table
records the PowerShell installer as **never executed**; this is its first real run, so budget time
for it to fail.

### 23. Tamper check — BOBBY RUNS

On any one of the machines, append a byte to the downloaded `SHA256SUMS` and re-run the installer.
Evidence: it refuses with the signature failure and installs nothing. Verified locally on
2026-09-13 (`minisign -V` exit 1; `verifyArtifact` throws); this confirms it end to end over the
real release.

### 24. `trent desktop install` — BOBBY, expected to find nothing in v1

```sh
trent desktop install --json
```

Expected evidence in v1: it reports **no matching desktop asset** for this platform, because the
`desktop` job in `release.yml` is gated on the repository variable `TRENT_RELEASE_DESKTOP`, which
does not exist. Record that as the v1 state rather than treating it as a regression;
`05_release/CONTEXT.md` step 5 and `05_release/output/release-runbook.md` ("Desktop bundles") say
the same thing, and the runbook is the source for enabling it. Enabling it
later means a matrix on `macos-latest` / `macos-13` / `windows-latest` / `ubuntu-latest`, asset
names exactly `desktopBundleName()` (`packages/trent-core/src/updater/desktop.ts`), those bundles
included in the SAME `SHA256SUMS` **before** signing, and a launch check per OS.

---

## Phase 5 — rollback (step 25)

### 25. Roll back — BOBBY

```sh
gh release delete v1.0.0 --cleanup-tag --yes
```

What this does and does not do:

- The release and its tag are gone; `releases/latest` falls back to the previous release, so the
  installers keep working and resolve to it. With no previous release, `install.sh` fails at the
  version resolution step and installs nothing, which is the correct failure.
- The **Pages site keeps serving** `install.sh` and `install.ps1`. They are not versioned and do not
  need to be removed; they resolve `releases/latest` at run time. The Pages gate governs new
  deploys only: deleting the last release does not retract an already-deployed site, it only stops
  the next push to `main` from redeploying one. With no release left, the served installer fails at
  `resolve-version` and installs nothing, which is the correct failure.
- Nothing needs to be un-signed. The signatures cover `SHA256SUMS`, which is gone with the release.
- The DNS record and the Pages configuration are untouched. Remove the DNS record only if the whole
  product is being withdrawn (`05_release/CONTEXT.md`, "Failure Behavior").

**Releases are immutable**: `publish` refuses to overwrite an existing release. A fix is v1.0.1, not
a re-cut v1.0.0.

---

## Step count and ownership

25 steps. **20 need Bobby**: 13 as **BOBBY** (a decision, a credential, DNS, visibility, a push or a
machine to test on — one of those, step 25, only happens on failure) and 7 as **BOBBY RUNS** (a local
command that changes nothing outside this machine). **5 are fully automated** once the tag is pushed:
the four `release.yml` jobs and the `Pages` deploy.

| Label | Steps | Count |
|---|---|---:|
| BOBBY | 1, 2, 4, 5, 6, 7, 8, 12, 20, 21, 22, 24, 25 | 13 |
| BOBBY RUNS | 3, 9, 10, 11, 17, 19, 23 | 7 |
| AUTOMATED | 13, 14, 15, 16, 18 | 5 |

---

## One source per question

The six places where these files used to contradict each other were resolved on 2026-09-18 (task
F0) rather than left to be discovered mid-release. Read the source named here and nothing else; if
a step in this checklist and that source ever disagree again, the source wins and this file is the
bug.

| Question | Single source | Settled as |
|---|---|---|
| Which `SHA256SUMS` is signed, and who produces it | `.github/workflows/release.yml` (sign job) | `dist/release/SHA256SUMS`, emitted by `binary.yml` only after each binary ran on its own OS, recomputed and compared before signing. `scripts/build-cli.sh`'s `dist/SHA256SUMS` is the local dry run only; `scripts/installer/keys/README.md` now says so |
| Whether real `minisign` can read the stored key | `scripts/installer/keys/README.md` + `node --test scripts/ci/minisign-key-format.test.mjs` | Yes, since `e65d88a`: `gen-keys.mjs` writes `kdf_alg "\0\0"`. `minisign-plain-key.mjs` stays as a pass-through for a secret captured from a pre-`e65d88a` key |
| Whether the installer pins a checksum | `scripts/installer/THREAT-MODEL.md`, "What the installer deliberately does not do" | It does not, by design: embedded public keys + a signature over the fetched `SHA256SUMS`. `05_release/CONTEXT.md` step 3 was corrected to match |
| Whether a desktop bundle ships in v1 | `05_release/output/release-runbook.md`, "Desktop bundles" | No. The `desktop` job is gated on the repository variable `TRENT_RELEASE_DESKTOP`, which does not exist. `CONTEXT.md` step 5 now says "deferred past v1"; step 24 above is the expected consequence |
| When Pages may serve `install.sh` | `.github/workflows/pages.yml` gate + `scripts/ci/pages-release-gate.mjs` | Only once a published, non-draft, non-prerelease release exists. A push to `main` before that skips `build` and `deploy` and prints why. Dispatch with `allow_without_release: true` for domain or certificate setup |
| What has never been run | `05_release/output/release-runbook.md`, "Not verified — and exactly where each one is found out" | One table there, naming the step in this file where each is found out. Not duplicated here |
