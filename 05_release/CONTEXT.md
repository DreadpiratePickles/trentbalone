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
1. Cross-compile all targets; **run each binary on its native OS** before publishing.
2. Publish binaries to GitHub Releases with SHA-256 sums.
3. Serve `install.sh` and `install.ps1` from `agent.let-trent.uk`; pin the checksum in the script.
4. Test the installer on a machine with no clone, no Node, no Bun.
5. Bundle the desktop app: vendored Bun runtime plus the standalone web build as resources.
6. Tag, write release notes, update docs in the same change as the behaviour.

## Outputs
| Path | Format | Consumer |
|---|---|---|
| GitHub Release assets | binaries + `SHA256SUMS` | users |
| `agent.let-trent.uk/install.sh` | shell | users |
| `output/release-notes.md` | markdown | users |
| `output/install-verification.md` | markdown, clean-machine transcript | user |

## Verify
- `curl -fsSL https://agent.let-trent.uk/install.sh | bash` succeeds with no clone and no runtime present.
- Checksum verification fails loudly on a tampered download.
- `trent doctor` passes on the freshly installed machine.
- The desktop bundle launches and loads the web app on a random free port.

## Approval
**User gate.** Every outward-facing action — push, publish, DNS change, release, visibility change —
requires explicit authorization. Default to private and unpublished.

## Failure Behavior
A binary that fails to run on its target is pulled from the release, not documented as a caveat.
A failed install on a clean machine blocks the release. Never advertise a URL that is not serving.
Roll back by deleting the release and the DNS record; the previous release stays untouched.
