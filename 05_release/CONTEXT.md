# Stage: 05_release

## Objective
Package and publish the verified product, and make the install path work for someone who has never seen
this repository.

## Inputs
| Path or source | Layer | Authority | Required |
|---|---:|---|---:|
| `04_verification/output/verification-report.md` | 4 | Gate | Yes |
| `01_discovery/output/distribution-feasibility.md` | 4 | Reference | Yes |
| Hermes parity checklist in `02_plan/output/design-doc.md` | 4 | Reference | Yes |

## Process
1. Cross-compile all targets; **run each binary on its native OS** before publishing
   (`.github/workflows/binary.yml`; `SHA256SUMS` is emitted only after every binary has run).
2. Publish binaries to GitHub Releases with SHA-256 sums, signed twice
   (`.github/workflows/release.yml`: `dist/release/SHA256SUMS` + `.minisig` + `.sig`).
3. Serve `install.sh` and `install.ps1` from `agent.let-trent.uk` (`.github/workflows/pages.yml`).
   The scripts **do not pin a checksum**: they embed the release *public keys*, fetch the resolved
   release's `SHA256SUMS`, require a valid signature over it, and only then check the artefact's
   digest. `scripts/installer/THREAT-MODEL.md` is the single source for this and explains why a
   pinned digest would be weaker. Pages refuses to deploy until a published release exists
   (`scripts/ci/pages-release-gate.mjs`), so the domain never advertises an install that 404s.
4. Test the installer on a machine with no clone, no Node, no Bun.
5. **Deferred past v1:** bundle the desktop app (vendored Bun runtime plus the standalone web build
   as resources). The `desktop` job in `release.yml` is gated on the repository variable
   `TRENT_RELEASE_DESKTOP`, which does not exist, so v1 ships no desktop asset and
   `trent desktop install` correctly reports none. `05_release/output/release-runbook.md`
   ("Desktop bundles") owns what enabling it requires.
6. Tag, write release notes, update docs in the same change as the behaviour.

## Outputs
| Path | Format | Consumer |
|---|---|---|
| GitHub Release assets | 4 binaries + `SHA256SUMS{,.minisig,.sig}` + `install.sh` + `install.ps1` (nine) | users |
| `agent.let-trent.uk/install.sh` | shell | users |
| `output/release-notes.md` | markdown | users |
| `output/install-verification.md` | markdown, clean-machine transcript | user |

## Verify
- `curl -fsSL https://agent.let-trent.uk/install.sh | bash` succeeds with no clone and no runtime present.
- Signature and checksum verification fail loudly on a tampered `SHA256SUMS` or a tampered binary.
- `trent doctor` passes on the freshly installed machine.
- Desktop only, once `TRENT_RELEASE_DESKTOP` is set: the bundle launches and loads the web app on a
  random free port. Not a v1 gate — see process step 5.

The ordered, executable form of all of this is `output/release-checklist-v1.md`.

## Approval
**User gate.** Every outward-facing action — push, publish, DNS change, release, visibility change —
requires explicit authorization. Default to private and unpublished.

## Failure Behavior
A binary that fails to run on its target is pulled from the release, not documented as a caveat.
A failed install on a clean machine blocks the release. Never advertise a URL that is not serving.
Roll back by deleting the release and the DNS record; the previous release stays untouched.
