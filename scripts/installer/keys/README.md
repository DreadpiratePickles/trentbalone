# Release signing keys

Two public keys are committed here and embedded in both installers by `render.sh`:

| file                   | algorithm     | who verifies it                                              |
|------------------------|---------------|--------------------------------------------------------------|
| `minisign.pub`         | Ed25519 (minisign format) | canonical: `trent update`, `trent desktop install`, `install.sh` via `minisign` or OpenSSL >= 1.1.1 |
| `ecdsa-p256.pub.pem`   | ECDSA P-256   | `install.sh` on hosts whose only openssl is LibreSSL (stock macOS has no Ed25519); `install.ps1` via CNG (.NET has no Ed25519) |

Why two: the shell installer must verify on a bare Mac, and `/usr/bin/openssl` there is LibreSSL
3.3.6, which cannot do Ed25519 or BLAKE2b (verified: `openssl genpkey -algorithm ed25519` ->
"Algorithm ed25519 not found"). The ECDSA key is a co-signature, not a downgrade: every path
performs a real cryptographic verification against a key embedded in the script, never fetched.

## Private keys — where they must live

`minisign.key` and `ecdsa-p256.key.pem` are gitignored (`.gitignore` in this directory). They
were generated on the developer machine on 2026-09-12 with `node gen-keys.mjs`; mode 0600.

They must be moved to the release job's secret store (GitHub Actions secrets
`TRENT_MINISIGN_KEY` and `TRENT_ECDSA_KEY`, written to disk only inside the signing step) and
the local copies removed once CI signs. They never go in the repo, a log, a chat transcript, or
`~/.trent`. If either is ever exposed: rotate with `node gen-keys.mjs --force`, re-render the
installers (`scripts/installer/render.sh`), and cut a new release; older installers embedding
the old public key will refuse the new release, which is the intended failure.

## What the release job runs

After `scripts/build-cli.sh` has produced `dist/SHA256SUMS`:

```
minisign -S -s "$RUNNER_TEMP/minisign.key" -m dist/SHA256SUMS -x dist/SHA256SUMS.minisig
openssl dgst -sha256 -sign "$RUNNER_TEMP/ecdsa-p256.key.pem" -out dist/SHA256SUMS.sig dist/SHA256SUMS
```

Upload to the GitHub Release, next to the binaries: `SHA256SUMS`, `SHA256SUMS.minisig`,
`SHA256SUMS.sig`. `node sign-sums.mjs dist/SHA256SUMS` produces byte-compatible output with both
commands and is what the tests use; the real tools are preferred in CI. `minisign` reads
`minisign.key` as generated here: kdf_alg `\0\0`, the same bytes `minisign -G -W` writes. (An
earlier revision wrote kdf_alg `Sc` with opslimit 0; real minisign keys off kdf_alg alone and
prompted for a password. `scripts/release/minisign-plain-key.mjs` converts such a key in place;
the release job still runs it defensively.) To add a password run `minisign -R -s minisign.key`
on a trusted machine and remove the conversion step.

## Formats (for the TypeScript verifier)

- `minisign.pub` line 2 = base64(`Ed` || key_id(8, little-endian u64) || pk(32)).
- `SHA256SUMS.minisig` line 2 = base64(`ED` || key_id(8) || sig(64)); `ED` means prehashed:
  sig = Ed25519(BLAKE2b-512(SHA256SUMS)). Line 4 = base64(Ed25519(sig || trusted_comment)).
- `SHA256SUMS.sig` = DER ECDSA signature over SHA-256(SHA256SUMS).
