# Installer threat model

Scope: `curl -fsSL https://agent.let-trent.uk/install.sh | bash` and `irm .../install.ps1 | iex`,
from the moment the script starts until `trent doctor` has run. The script itself is fetched
over HTTPS from `agent.let-trent.uk`; whoever controls that host or a CA the user trusts can
serve a different script, and no installer can defend against its own replacement. Everything
below assumes the script the user runs is ours, and asks what an attacker can do to the rest.

Trust anchors: the Ed25519 release key (`keys/minisign.pub`) and the ECDSA P-256 co-signing
key (`keys/ecdsa-p256.pub.pem`), both embedded in the script text. Nothing about verification
depends on fetching a key.

## Attackers and outcomes

| attacker controls | can | cannot | control that stops it |
|---|---|---|---|
| **DNS** for `github.com` / `objects.githubusercontent.com` | direct the download to their own server | serve anything the installer accepts: TLS 1.2+ with a certificate for the real hostname is required (`--proto '=https' --tlsv1.2`, no `-k`), so a DNS hijack without a CA compromise ends in a TLS failure | HTTPS-only, hostname verification |
| **DNS + a trusted CA** (or a corporate TLS-intercepting proxy) | serve a forged release: binary, `SHA256SUMS`, and signature files | make the forged `SHA256SUMS` verify: it is signed with a key they do not have. Install stops at `resolve-version` with "does NOT verify"; nothing is downloaded | embedded public keys; refusal of unsigned releases |
| **the CDN / release host** (GitHub's storage, a mirror) | replace the binary bytes; replace or delete `SHA256SUMS*` | pass verification: a changed binary fails the SHA-256 in the signed `SHA256SUMS` ("SHA-256 mismatch", expected vs actual named, download discarded); a changed `SHA256SUMS` fails the signature; a missing signature is refused ("no signature") | signature over checksums, per-artefact SHA-256, unsigned refusal |
| **the GitHub release itself** (a compromised maintainer account, but not the signing keys) | publish a new version with a malicious binary and a `SHA256SUMS` that matches it | sign it. Verification fails as above. They can also delete releases (denial of service) or publish a `v0.0.1` hoping to downgrade; the installer refuses to move backwards without `--force` | signing keys live outside GitHub (CI secret, README); refuse-downgrade |
| **the signing keys** | produce a release the installer accepts | nothing stops this. The keys must live in a CI secret store, never the repo; rotation and re-render are documented in `keys/README.md`. Older installers embed the old public key and will refuse the rotated release, which is the intended alarm | key custody, rotation procedure |
| **a redirect** (open redirect on the release host, or an on-path attacker after TLS termination at a proxy) | bounce the download to another host | have that host's bytes installed: after curl follows redirects the effective URL's host must be one of the release hosts (`github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`); otherwise the file is discarded ("not a release host") | effective-URL host allowlist, `--max-redirs 5` |
| **the release metadata** (the `releases/latest` redirect, a `--version` argument, a tag name) | supply `../../x`, `1.0.0; rm -rf ~`, `%2f`-encoded paths | have it reach a URL or a filesystem path: the version must match `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$` first; the redirect host is also checked | strict version pattern before use; no `eval`; every expansion quoted |
| **the network** (drops, truncation, a proxy that cuts the body) | interrupt the transfer | leave a partial binary: curl fails on a short body, the received byte count must equal `Content-Length`, the SHA-256 must match, and only a file that passed all three is renamed into `versions/<v>/`. Partial files live in a private run directory that is removed on exit | length check, hash check, private staging, atomic rename |
| **another local user** on a shared machine | watch `/tmp`; race a world-writable directory | swap the file between verification and install: the download and its verification happen in `~/.trent/staging/run.XXXXXX` created with `umask 077` (mode 0700) on the same filesystem as `versions/`, and the verified file is renamed, never copied, into place. `~/.trent/installer/state` is 0600 | umask 077, private staging dir under `$HOME`, rename not copy |
| **the user's PATH** (a malicious `curl`, `openssl`, `shasum`, `id`, `uname` earlier on PATH) | subvert the installer completely | be defended against by the installer: a hostile PATH already means arbitrary code runs as this user. What the installer does: it uses only tools found on PATH and never `sudo`, so the damage is bounded to the user's account; it refuses to run as root unless `--allow-root`, so a hostile PATH cannot ride an installer to uid 0. The tests use this very mechanism (a fake `id` printing 0) to exercise the root refusal | no sudo; root refusal; nothing written outside `$HOME` |
| **root / an already-compromised account** | anything | — | out of scope |
| **the user, by mistake** (`TRENT_HOME=/usr/local`, running as root "to be safe", pointing at a dev server) | — | write outside `$HOME` (`TRENT_HOME` must be under `$HOME`); run as root without `--allow-root`; use a non-GitHub base URL without `--insecure-base-url`, which prints a loud warning and still enforces signature and hash checks | explicit flags for every unsafe choice |

## What the installer deliberately does not do

- Fetch a key, a script, or a "bootstrap" from anywhere: no nested `curl | sh`, no `eval`.
- Run `sudo` or write to `/usr/local`, `/etc`, or system profiles.
- Delete anything: a directory it must replace is moved to `<dir>.broken-<utc-timestamp>`.
- Continue silently past a failed stage: every stage emits a frame, and a failure skips the rest
  with `"reason":"not run: stage X failed"` so a GUI driving `--json` can never see a gap.

## Residual risks, stated plainly

1. **Two signing keys, either sufficient.** Because stock macOS cannot verify Ed25519, the shell
   installer accepts the ECDSA co-signature when it cannot check the minisig. Security equals the
   weaker-protected of the two private keys; both must be protected identically (`keys/README.md`).
2. **The script's own delivery.** `agent.let-trent.uk` and the CA system are the root of trust for
   the script text. Pinning the public keys inside the script makes a *release* compromise
   survivable; it does not make a *script* compromise survivable. Publishing the script's own
   SHA-256 on a second channel (the README) lets careful users check it, and is recommended.
3. **`trent setup` and `trent doctor` run the freshly installed binary.** By then it has been
   verified; but anything the binary does with the user's environment is the binary's threat
   model, not the installer's.
4. **Windows verification path** uses CNG with a hand-decoded DER signature and has not yet been
   executed on Windows in this repo (no `pwsh` here; milestone 5.4 requires CI on Windows).
