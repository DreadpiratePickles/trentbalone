# Milestone 5 — Installer (task-level)

Bar to beat, from reading Hermes's own installer: a staged installer with a machine-readable protocol
(`--manifest` lists stages, `--stage <name>` runs one, `--json` emits per-stage `{ok:...}` frames), a
branded banner, and the setup wizard run inside the install. Their weaknesses, which we fix: the script
curl-executes a dependency installer from a mutable URL with **no version pin and no checksum**, it can
abort the whole install on a single transient HTTP failure, and it needs Python, Node, ripgrep, ffmpeg
and a browser engine on the user's machine.

Our advantage: one compiled binary, nothing to install alongside it.

---

## 5.1 — Build the binary
- `bun build --compile` for `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-windows-x64`.
- **Three standing rules, each learned from a failure:**
  1. `react-devtools-core` must be a real dependency. Ink declares it as a peer that npm does not
     install, and marking it external produces a binary that compiles cleanly and dies on launch.
  2. No `.node` native addons anywhere in the CLI import graph. One cross-compiled with exit 0 and
     embedded macOS headers inside an ELF binary.
  3. **CI must RUN each binary on its native OS.** Compile success is not evidence.
- **RED test:** the build script fails loudly if any `--external` flag appears in the command line.

## 5.2 — Checksums and the release
- Emit `SHA256SUMS` beside the binaries; publish to GitHub Releases.
- **RED test:** tamper one byte of a downloaded artifact and assert the installer refuses and exits
  non-zero with a message naming the expected and actual digest.

## 5.3 — The staged installer
- Stages: `detect` -> `resolve-version` -> `download` -> `verify` -> `install` -> `path` -> `setup` -> `doctor`.
- `--manifest` prints the stage list as JSON. `--stage <name>` runs exactly one. `--json` emits one
  frame per stage. This is what lets a future GUI installer drive it, and it is how Hermes does it.
- Idempotent: re-running changes nothing once installed. Resumable: a failed stage can be retried
  without repeating the successful ones.
- **No sudo.** Everything under `~/.trent`. PATH line appended only if absent, and the exact line is
  printed so the user can add it themselves.
- **RED tests:** manifest is valid JSON; a simulated network failure at `download` leaves no partial
  binary and exits non-zero; running the installer twice is a no-op the second time; the PATH line is
  never duplicated.

## 5.4 — Windows
`install.ps1` mirrors the same stages. Either it is built and RUN in CI, or Windows is explicitly scoped
out in the docs. No middle position — the previous effort shipped a Windows script with the same fatal
path bug as the shell one and nobody ran it.

## 5.5 — Hosting
- Binaries: GitHub Releases (no size cap, versioned, free).
- `agent.let-trent.uk`: a DNS record to a static host serving `install.sh` and `install.ps1` over HTTPS.
  The Cloudflare token available is **DNS-only** — verified: it reads the zone but is refused for R2 and
  Pages. Serving from Cloudflare directly would need a token with R2 edit permission.
- **RED test:** `curl -fsSL https://agent.let-trent.uk/install.sh | bash` on a machine with no clone, no
  Node and no Bun ends with a working `trent doctor`. Until that passes, the URL is not advertised
  anywhere, including the README.

## 5.6 — Uninstall
`trent uninstall` removes the binary, the PATH line and optionally `~/.trent`, and asks before deleting
user data. Hermes has a three-tier version of this; we match it.
- **RED test:** after uninstall, `trent` is not on PATH and no file remains outside what the user chose
  to keep.

## Done when
A clean machine goes from one command to a passing doctor, a tampered download is refused, and the
whole thing is idempotent.
