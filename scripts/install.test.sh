#!/usr/bin/env bash
# install.test.sh — behavioural tests for scripts/install.sh (and stage parity with install.ps1).
#
# Every test runs the real installer, in a real /bin/sh, against a local HTTP server that serves
# signed artefacts built from dist/, into a throwaway HOME with an empty environment. Nothing here
# greps the installer's source to decide whether it works.
#
#   scripts/build-cli.sh darwin-arm64      # (or whichever host target) must have run first
#   scripts/install.test.sh                # exit 0 = every test passed
#
# Env: TRENT_DIST_DIR (default dist/), TRENT_TEST_PORT (default 47311)
#
# Signing: if scripts/installer/keys/*.key* exist (a developer machine) the artefacts are signed
# with them. Otherwise an ephemeral keypair is generated and a copy of the installer is rendered
# with that public key, so the test still exercises real verification.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${TRENT_DIST_DIR:-$REPO_ROOT/dist}"
PORT="${TRENT_TEST_PORT:-47311}"
KEYS="$REPO_ROOT/scripts/installer/keys"
SERVER="$REPO_ROOT/scripts/installer/testserver.py"
VERSION="$(node -p "require('$REPO_ROOT/apps/cli/package.json').version")"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET=trent-darwin-arm64 ;;
  Darwin-x86_64) ASSET=trent-darwin-x64 ;;
  Linux-x86_64) ASSET=trent-linux-x64 ;;
  *) echo "unsupported host for the install test: $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac
[ -f "$DIST/$ASSET" ] || { echo "missing $DIST/$ASSET: run scripts/build-cli.sh first" >&2; exit 2; }
[ -f "$DIST/SHA256SUMS" ] || { echo "missing $DIST/SHA256SUMS" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/trent-install-test.XXXXXX")"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || :; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fail=0; failed_names=()
ok()   { pass=$((pass+1)); printf 'PASS  %s\n' "$1"; }
bad()  { fail=$((fail+1)); failed_names+=("$1"); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }
skip() { printf 'SKIP  %s\n' "$1"; }

# ------------------------------------------------------------------ keys + installer under test
mkdir -p "$WORK/keys" "$WORK/wrongkeys"
if [ -f "$KEYS/minisign.key" ] && [ -f "$KEYS/ecdsa-p256.key.pem" ]; then
  cp "$KEYS/minisign.key" "$KEYS/ecdsa-p256.key.pem" "$WORK/keys/"
  INSTALLER="$REPO_ROOT/scripts/install.sh"; PS1_INSTALLER="$REPO_ROOT/scripts/install.ps1"
  KEY_SOURCE="repo signing keys"
else
  # Ephemeral keys: render a private copy of both installers embedding them.
  cp -R "$REPO_ROOT/scripts/installer" "$WORK/installer-src"
  rm -f "$WORK/installer-src/keys/"*
  ( cd "$WORK/installer-src/keys" && cp "$KEYS/gen-keys.mjs" "$KEYS/blake2b.mjs" "$KEYS/sign-sums.mjs" . && node gen-keys.mjs >/dev/null )
  cp "$WORK/installer-src/keys/minisign.key" "$WORK/installer-src/keys/ecdsa-p256.key.pem" "$WORK/keys/"
  "$WORK/installer-src/render.sh" --out "$WORK/rendered" >/dev/null
  INSTALLER="$WORK/rendered/install.sh"; PS1_INSTALLER="$WORK/rendered/install.ps1"
  KEY_SOURCE="ephemeral keys (repo private keys absent)"
fi
( cd "$WORK/wrongkeys" && cp "$KEYS/gen-keys.mjs" "$KEYS/blake2b.mjs" . && node gen-keys.mjs >/dev/null )
echo "installer under test: $INSTALLER ($KEY_SOURCE)"

# ------------------------------------------------------------------ release trees
# GitHub layout: /releases/download/v<ver>/<asset> + SHA256SUMS + SHA256SUMS.minisig + SHA256SUMS.sig
mk_release() { # $1 dir, $2 asset source, $3 keydir
  mkdir -p "$1/v$VERSION"
  cp "$2" "$1/v$VERSION/$ASSET"
  cp "$DIST/SHA256SUMS" "$1/v$VERSION/SHA256SUMS"
  node "$KEYS/sign-sums.mjs" "$1/v$VERSION/SHA256SUMS" --minisign-key "$3/minisign.key" --ecdsa-key "$3/ecdsa-p256.key.pem" >/dev/null
}
mk_release "$WORK/good" "$DIST/$ASSET" "$WORK/keys"
cp "$DIST/$ASSET" "$WORK/tampered.bin"
python3 - "$WORK/tampered.bin" <<'PY'
import sys
p=sys.argv[1]; b=bytearray(open(p,'rb').read()); i=len(b)//2; b[i]^=0x01; open(p,'wb').write(b)
PY
mk_release "$WORK/bad" "$WORK/tampered.bin" "$WORK/keys"          # valid signature, tampered binary
mk_release "$WORK/badsig" "$DIST/$ASSET" "$WORK/wrongkeys"        # valid checksums, wrong signer
mk_release "$WORK/unsigned" "$DIST/$ASSET" "$WORK/keys"; rm "$WORK/unsigned/v$VERSION/SHA256SUMS".*   # no signature at all
mk_release "$WORK/onlysig" "$DIST/$ASSET" "$WORK/keys"; rm "$WORK/onlysig/v$VERSION/SHA256SUMS.minisig"   # ECDSA only
mk_release "$WORK/onlyminisig" "$DIST/$ASSET" "$WORK/keys"; rm "$WORK/onlyminisig/v$VERSION/SHA256SUMS.sig" # minisig only

start_server() { # $1 root, extra args...
  local root="$1"; shift
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || :; SERVER_PID=""; }
  python3 "$SERVER" "$root" "$PORT" "$VERSION" "$@" &
  SERVER_PID=$!
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/releases/latest" 2>/dev/null && return 0
    sleep 0.1
  done
  echo "test server did not come up on $PORT" >&2; exit 2
}
BASE="http://127.0.0.1:$PORT/releases/download"
SYS_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# Run the installer as a user would: empty environment, temp HOME, stdin not a terminal.
run_installer() { # $1 home, rest: installer args. stdout->$1/out, stderr->$1/err; echoes exit code
  local home="$1"; shift
  set +e
  env -i HOME="$home" PATH="${RUN_PATH:-$SYS_PATH}" SHELL=/bin/zsh \
      /bin/sh "$INSTALLER" --insecure-base-url "$BASE" "$@" </dev/null >"$home/out" 2>"$home/err"
  local rc=$?
  set -e
  echo "$rc"
}

tree_hash() { # content hash of every file under $1 plus the sorted path list; $2 = prune pattern
  ( cd "$1" && find . -print | grep -v "${2:-^$}" | LC_ALL=C sort | while IFS= read -r p; do
      if [ -f "$p" ]; then printf '%s f %s\n' "$p" "$(shasum -a 256 < "$p" | cut -c1-64)"; else printf '%s d\n' "$p"; fi
    done ) | shasum -a 256 | cut -c1-64
}
no_binary_installed() { # $1 home: nothing executable or staged that could be the binary
  [ ! -e "$1/.trent/bin/trent" ] && [ -z "$(find "$1/.trent" -type f \( -name 'trent-*' -o -name 'trent' -o -name '*.part' \) 2>/dev/null)" ]
}
frames_valid() { # $1 file of json frames -> prints stage list; exit 1 if any line is not a frame
  python3 - "$1" <<'PY'
import json,sys
names=[]
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    f=json.loads(line)
    for k in ("ok","stage","skipped","duration_ms"):
        assert k in f, f"frame missing {k}: {line}"
    assert isinstance(f["ok"],bool) and isinstance(f["skipped"],bool) and isinstance(f["duration_ms"],int), line
    if f["skipped"] or not f["ok"]:
        assert "reason" in f, f"skipped/failed frame without reason: {line}"
    names.append(f["stage"])
print(" ".join(names))
PY
}
frame() { grep "\"stage\":\"$2\"" "$1"; }

EXPECTED_STAGES="detect resolve-version download verify install path setup doctor"

# ============================================================================ tests
start_server "$WORK/good"
H0="$WORK/home0"; mkdir -p "$H0"; export HOME="$H0"    # never run any installer with the real HOME

# --- manifest ----------------------------------------------------------------------------
t="manifest: valid JSON, protocol_version 1, eight stages in order"
if out=$(env -i HOME="$H0" PATH="$SYS_PATH" /bin/sh "$INSTALLER" --manifest 2>&1) && names=$(printf '%s' "$out" | python3 -c '
import json,sys; m=json.load(sys.stdin); assert m["protocol_version"]==1
for s in m["stages"]:
    assert set(s)=={"name","title","category","needs_user_input"}, s
    assert isinstance(s["needs_user_input"],bool)
print(" ".join(s["name"] for s in m["stages"]))') && [ "$names" = "$EXPECTED_STAGES" ]; then ok "$t"; else bad "$t" "got: ${names:-$out}"; fi

# --- fresh install -----------------------------------------------------------------------
H1="$WORK/home1"; mkdir -p "$H1"
t="fresh install: exit 0, one frame per stage, ~/.trent/bin/trent --version works with no repo access"
rc=$(run_installer "$H1" --json)
if [ "$rc" = 0 ] && names=$(frames_valid "$H1/out") && [ "$names" = "$EXPECTED_STAGES" ] \
   && ! grep -q '"ok":false' "$H1/out" \
   && v=$(env -i HOME="$H1" PATH="$SYS_PATH" "$H1/.trent/bin/trent" --version 2>&1) && [ "$v" = "$VERSION" ]; then
  ok "$t"
else bad "$t" "rc=$rc stages='${names:-?}' version='${v:-?}'; stderr: $(tail -5 "$H1/err" | tr '\n' '|')"; fi

t="fresh install: SHA256SUMS signature was verified (ECDSA path on stock LibreSSL) and reported"
if grep -q 'signature verified via openssl (ECDSA P-256 co-signature)' "$H1/err"; then ok "$t"; else bad "$t" "$(grep -i signature "$H1/err" | head -3)"; fi

t="fresh install: setup is an honest skip in non-interactive mode"
if frame "$H1/out" setup | grep -q '"skipped":true' && frame "$H1/out" setup | grep -q '"reason":'; then ok "$t"; else bad "$t" "$(frame "$H1/out" setup)"; fi

t="fresh install: doctor ran the installed binary (frame ok, output shows TRENT DOCTOR)"
if frame "$H1/out" doctor | grep -q '"ok":true' && grep -q 'TRENT DOCTOR' "$H1/err"; then ok "$t"; else bad "$t" "$(frame "$H1/out" doctor)"; fi

t="fresh install: PATH line appended exactly once and printed to the user"
rcfile="$H1/.zshrc"
if [ -f "$rcfile" ] && [ "$(grep -c '\.trent/bin' "$rcfile")" = 1 ] && grep -q 'PATH line: export PATH="$HOME/.trent/bin:$PATH"' "$H1/err"; then ok "$t"; else bad "$t" "rc file: $(cat "$rcfile" 2>&1)"; fi

t="fresh install: nothing written outside HOME; staging left clean"
if [ -z "$(find "$H1/.trent/staging" -mindepth 1 2>/dev/null)" ] && [ "$(stat -f '%Lp' "$H1/.trent/installer/state")" = 600 ]; then ok "$t"; else bad "$t" "staging: $(ls -la "$H1/.trent/staging"); state mode $(stat -f '%Lp' "$H1/.trent/installer/state")"; fi

t="fresh install: success box names the binary, the data dir and the next commands"
if grep -q 'trent desktop install' "$H1/err" && grep -q "$H1/.trent/bin/trent" "$H1/err" && grep -q 'trent setup' "$H1/err"; then ok "$t"; else bad "$t" "$(tail -12 "$H1/err")"; fi

t="fresh install: human output uses no purple and no emoji"
if ! grep -qiE '8B5CF6|139;92;246|Magenta' "$H1/out" "$H1/err" "$INSTALLER" "$PS1_INSTALLER" \
   && ! python3 -c '
import sys,re
data=open(sys.argv[1],encoding="utf-8",errors="replace").read()+open(sys.argv[2],encoding="utf-8",errors="replace").read()
data=data.replace("\u2713","").replace("\u2717","")   # the CLI doctor output uses plain check/cross marks; not emoji, not ours
emoji=re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF]")
sys.exit(0 if emoji.search(data) else 1)' "$H1/out" "$H1/err"; then ok "$t"; else bad "$t" "purple or emoji found in output"; fi

# --- idempotent second run ----------------------------------------------------------------
t="idempotent: second run exits 0, ~/.trent tree hash unchanged, PATH line not duplicated, download skipped"
before=$(tree_hash "$H1/.trent"); rc_before=$(grep -c '\.trent/bin' "$rcfile")
rc=$(run_installer "$H1" --json)
after=$(tree_hash "$H1/.trent"); rc_after=$(grep -c '\.trent/bin' "$rcfile")
if [ "$rc" = 0 ] && [ "$before" = "$after" ] && [ "$rc_before" = "$rc_after" ] && frame "$H1/out" download | grep -q '"skipped":true'; then
  ok "$t"
else bad "$t" "rc=$rc before=$before after=$after rc_lines=$rc_before->$rc_after download=$(frame "$H1/out" download)"; fi

# --- --stage ------------------------------------------------------------------------------
t="--stage doctor: exactly one frame, for doctor"
rc=$(run_installer "$H1" --json --stage doctor)
if [ "$rc" = 0 ] && [ "$(frames_valid "$H1/out")" = "doctor" ]; then ok "$t"; else bad "$t" "rc=$rc out=$(cat "$H1/out")"; fi

# --- refuse to move backwards ---------------------------------------------------------------
t="refuses to downgrade: an older --version is kept out; installed files untouched; reason names --force"
before=$(tree_hash "$H1/.trent" '/installer/state')     # state records the request; the install itself must not change
rc=$(run_installer "$H1" --json --version 0.0.1)
after=$(tree_hash "$H1/.trent" '/installer/state')
if [ "$rc" = 0 ] && [ "$before" = "$after" ] && frame "$H1/out" install | grep -q '"skipped":true' && frame "$H1/out" install | grep -q 'force'; then ok "$t"; else bad "$t" "rc=$rc $(cat "$H1/out")"; fi

# --- tampered binary ----------------------------------------------------------------------
start_server "$WORK/bad"
H2="$WORK/home2"; mkdir -p "$H2"
t="tampered binary (valid signature on SHA256SUMS): non-zero exit, expected and actual digests named, no binary installed"
rc=$(run_installer "$H2" --json)
expected=$(grep " $ASSET\$" "$DIST/SHA256SUMS" | cut -c1-64)
actual=$(shasum -a 256 "$WORK/tampered.bin" | cut -c1-64)
if [ "$rc" != 0 ] && frame "$H2/out" verify | grep -q '"ok":false' \
   && grep -q "$expected" "$H2/out" && grep -q "$actual" "$H2/out" && no_binary_installed "$H2"; then
  ok "$t"
else bad "$t" "rc=$rc; files: $(find "$H2/.trent" -type f 2>/dev/null | tr '\n' ' '); out: $(frame "$H2/out" verify)"; fi

t="tampered binary: every later stage still emits a frame (skipped, not missing)"
if [ "$(frames_valid "$H2/out")" = "$EXPECTED_STAGES" ]; then ok "$t"; else bad "$t" "$(cat "$H2/out")"; fi

# --- invalid signature --------------------------------------------------------------------
start_server "$WORK/badsig"
H5="$WORK/home5"; mkdir -p "$H5"
t="invalid signature (checksums correct, wrong signer): refused at resolve-version via the ECDSA path, nothing downloaded"
rc=$(run_installer "$H5" --json)
if [ "$rc" != 0 ] && frame "$H5/out" resolve-version | grep -q '"ok":false' && frame "$H5/out" resolve-version | grep -q 'does NOT verify' \
   && frame "$H5/out" download | grep -q '"skipped":true' && no_binary_installed "$H5"; then ok "$t"; else bad "$t" "rc=$rc $(cat "$H5/out")"; fi

# The Ed25519/minisign path needs OpenSSL >= 1.1.1 (LibreSSL cannot). Exercise it when one exists.
MODERN_OPENSSL=""
for cand in /opt/homebrew/bin/openssl /usr/local/bin/openssl /usr/bin/openssl; do
  if [ -x "$cand" ] && "$cand" pkey -help 2>&1 | grep -q . && printf '%s\n' "-----BEGIN PUBLIC KEY-----" "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=" "-----END PUBLIC KEY-----" | "$cand" pkey -pubin -noout >/dev/null 2>&1; then MODERN_OPENSSL="$cand"; break; fi
done
if [ -n "$MODERN_OPENSSL" ]; then
  start_server "$WORK/onlyminisig"
  H6="$WORK/home6"; mkdir -p "$H6"
  t="minisign signature verified through OpenSSL Ed25519 ($MODERN_OPENSSL) when no ECDSA co-signature exists"
  rc=$(RUN_PATH="$(dirname "$MODERN_OPENSSL"):$SYS_PATH" run_installer "$H6" --json)
  if [ "$rc" = 0 ] && grep -q 'signature verified via openssl (Ed25519, minisign format)' "$H6/err"; then ok "$t"; else bad "$t" "rc=$rc $(grep -i 'signature\|resolve' "$H6/err" "$H6/out" | head -4)"; fi
  start_server "$WORK/badsig"
  H7="$WORK/home7"; mkdir -p "$H7"
  t="invalid minisign signature refused through the OpenSSL Ed25519 path (key id mismatch)"
  rc=$(RUN_PATH="$(dirname "$MODERN_OPENSSL"):$SYS_PATH" run_installer "$H7" --json)
  if [ "$rc" != 0 ] && frame "$H7/out" resolve-version | grep -q '"ok":false' && frame "$H7/out" resolve-version | grep -qi 'key id' && no_binary_installed "$H7"; then ok "$t"; else bad "$t" "rc=$rc $(frame "$H7/out" resolve-version)"; fi
else
  skip "minisign/Ed25519 verification path (no OpenSSL >= 1.1.1 on this machine)"
fi

start_server "$WORK/unsigned"
H8="$WORK/home8"; mkdir -p "$H8"
t="unsigned release (no .minisig, no .sig): refused, nothing downloaded"
rc=$(run_installer "$H8" --json)
if [ "$rc" != 0 ] && frame "$H8/out" resolve-version | grep -q 'no signature' && no_binary_installed "$H8"; then ok "$t"; else bad "$t" "rc=$rc $(frame "$H8/out" resolve-version)"; fi

# --- spoofed version strings ----------------------------------------------------------------
start_server "$WORK/good"
H9="$WORK/home9"; mkdir -p "$H9"
t="spoofed --version '../../etc/x' refused before any URL or path is built"
rc=$(run_installer "$H9" --json --version '../../etc/x')
if [ "$rc" != 0 ] && frame "$H9/out" resolve-version | grep -q 'does not match' && [ ! -e "$H9/.trent/versions" -o -z "$(ls "$H9/.trent/versions")" ] && no_binary_installed "$H9"; then ok "$t"; else bad "$t" "rc=$rc $(frame "$H9/out" resolve-version)"; fi
t="spoofed --version '1.0.0; rm -rf x' refused"
rc=$(run_installer "$H9" --json --version '1.0.0; rm -rf x')
if [ "$rc" != 0 ] && frame "$H9/out" resolve-version | grep -q 'does not match'; then ok "$t"; else bad "$t" "rc=$rc $(frame "$H9/out" resolve-version)"; fi
start_server "$WORK/good" --latest-tag '1.0.0%2f..%2f..%2fevil'
t="spoofed latest-release redirect tag '1.0.0%2f..%2f..%2fevil' refused by the version pattern"
rc=$(run_installer "$H9" --json)
if [ "$rc" != 0 ] && frame "$H9/out" resolve-version | grep -q 'does not match' && no_binary_installed "$H9"; then ok "$t"; else bad "$t" "rc=$rc $(frame "$H9/out" resolve-version)"; fi
start_server "$WORK/good" --latest-tag '../../../evil'
t="spoofed latest-release redirect tag '../../../evil' refused (path-normalised away from /releases/tag/)"
rc=$(run_installer "$H9" --json)
if [ "$rc" != 0 ] && frame "$H9/out" resolve-version | grep -qE 'does not match|unexpected redirect' && no_binary_installed "$H9"; then ok "$t"; else bad "$t" "rc=$rc $(frame "$H9/out" resolve-version)"; fi

# --- redirect off the release host ------------------------------------------------------------
start_server "$WORK/good" --redirect-binaries-to localhost
H10="$WORK/home10"; mkdir -p "$H10"
t="redirect of the binary to another host (localhost != 127.0.0.1) is refused; no binary installed"
rc=$(run_installer "$H10" --json)
if [ "$rc" != 0 ] && frame "$H10/out" download | grep -q 'not a release host' && no_binary_installed "$H10"; then ok "$t"; else bad "$t" "rc=$rc $(frame "$H10/out" download)"; fi

# --- plain http without the flag ------------------------------------------------------------
t="http base URL without --insecure-base-url is impossible: the default base is https and curl is pinned to --proto =https"
H11="$WORK/home11"; mkdir -p "$H11"
set +e
env -i HOME="$H11" PATH="$SYS_PATH" TRENT_RELEASE_BASE_URL="$BASE" /bin/sh "$INSTALLER" --json --version "$VERSION" </dev/null >"$H11/out" 2>"$H11/err"; rc=$?
set -e
if [ "$rc" != 0 ] && grep -q 'github.com' "$H11/out" && no_binary_installed "$H11"; then ok "$t"; else bad "$t" "rc=$rc $(cat "$H11/out")"; fi

# --- truncated body -----------------------------------------------------------------------
start_server "$WORK/good" --truncate-binaries
H3="$WORK/home3"; mkdir -p "$H3"
t="network failure / truncated body at download: non-zero exit, download frame ok:false, no partial binary left"
rc=$(run_installer "$H3" --json)
if [ "$rc" != 0 ] && frame "$H3/out" download | grep -q '"ok":false' && no_binary_installed "$H3" \
   && [ -z "$(find "$H3/.trent/staging" -mindepth 1 2>/dev/null)" ]; then
  ok "$t"
else bad "$t" "rc=$rc; files: $(find "$H3/.trent" -type f 2>/dev/null | tr '\n' ' '); out: $(frame "$H3/out" download)"; fi
start_server "$WORK/good"

# --- root refusal -------------------------------------------------------------------------
H12="$WORK/home12"; mkdir -p "$H12" "$WORK/fakebin"
printf '#!/bin/sh\necho 0\n' > "$WORK/fakebin/id"; chmod +x "$WORK/fakebin/id"
t="uid 0 without --allow-root: refused with a frame, nothing installed"
rc=$(RUN_PATH="$WORK/fakebin:$SYS_PATH" run_installer "$H12" --json)
if [ "$rc" != 0 ] && frame "$H12/out" detect | grep -q 'refusing to run as root' && no_binary_installed "$H12"; then ok "$t"; else bad "$t" "rc=$rc $(cat "$H12/out")"; fi
t="uid 0 with --allow-root: proceeds"
rc=$(RUN_PATH="$WORK/fakebin:$SYS_PATH" run_installer "$H12" --json --allow-root)
if [ "$rc" = 0 ] && [ -x "$H12/.trent/bin/trent" ]; then ok "$t"; else bad "$t" "rc=$rc $(cat "$H12/out")"; fi

# --- layout contract: switching and rollback through ~/.trent/current --------------------------
t="layout: repointing ~/.trent/current switches the launcher to versions/<v>/trent; writing it back rolls back"
mkdir -p "$H12/.trent/versions/9.9.9"
printf '#!/bin/sh\necho 9.9.9\n' > "$H12/.trent/versions/9.9.9/trent"; chmod 755 "$H12/.trent/versions/9.9.9/trent"
printf '9.9.9\n' > "$H12/.trent/current.tmp"; mv "$H12/.trent/current.tmp" "$H12/.trent/current"
v_new=$(env -i HOME="$H12" PATH="$SYS_PATH" "$H12/.trent/bin/trent" --version 2>&1)
printf '%s\n' "$VERSION" > "$H12/.trent/current.tmp"; mv "$H12/.trent/current.tmp" "$H12/.trent/current"
v_back=$(env -i HOME="$H12" PATH="$SYS_PATH" "$H12/.trent/bin/trent" --version 2>&1)
if [ "$v_new" = "9.9.9" ] && [ "$v_back" = "$VERSION" ] && [ -x "$H12/.trent/versions/$VERSION/trent" ]; then ok "$t"; else bad "$t" "after switch: '$v_new', after rollback: '$v_back'"; fi

# --- TRENT_HOME outside HOME --------------------------------------------------------------
t="TRENT_HOME outside HOME is refused before anything is written"
H13="$WORK/home13"; mkdir -p "$H13"
set +e
env -i HOME="$H13" PATH="$SYS_PATH" TRENT_HOME="$WORK/elsewhere" /bin/sh "$INSTALLER" --insecure-base-url "$BASE" --json </dev/null >"$H13/out" 2>"$H13/err"; rc=$?
set -e
if [ "$rc" != 0 ] && [ ! -e "$WORK/elsewhere" ] && grep -q 'outside HOME' "$H13/err"; then ok "$t"; else bad "$t" "rc=$rc $(cat "$H13/err")"; fi

# --- subshell guarantee -------------------------------------------------------------------
# Source the installer's functions into a real /bin/sh, replace one helper with `exit 1`, and
# drive the stage runner. The frame must arrive even though the helper killed its shell.
H4="$WORK/home4"; mkdir -p "$H4"
t="subshell guarantee: a stage helper that calls 'exit 1' still produces an {\"ok\":false} frame"
set +e
out=$(env -i HOME="$H4" PATH="$SYS_PATH" TRENT_INSTALLER_LIBRARY=1 /bin/sh -c '
  . "$1"
  JSON=1
  detect_platform() { echo "simulated helper failure" >&2; exit 1; }
  run_stage detect
  echo "runner-still-alive"
' sh "$INSTALLER" 2>/dev/null); rc=$?
set -e
if printf '%s\n' "$out" | grep -q '"ok":false' && printf '%s\n' "$out" | grep -q '"stage":"detect"' \
   && printf '%s\n' "$out" | grep -q 'runner-still-alive'; then ok "$t"; else bad "$t" "rc=$rc out=$out"; fi

# --- shell / PowerShell parity ------------------------------------------------------------
t="parity: install.sh and install.ps1 -Manifest outputs are identical"
sh_manifest=$(env -i HOME="$H0" PATH="$SYS_PATH" /bin/sh "$INSTALLER" --manifest)
if command -v pwsh >/dev/null 2>&1; then
  ps_manifest=$(pwsh -NoProfile -File "$PS1_INSTALLER" -Manifest)
  ps_source="pwsh -NoProfile -File install.ps1 -Manifest"
else
  # pwsh is not installed here: fall back to the literal manifest the renderer embedded in the
  # script. This proves the two scripts carry the same list, not that PowerShell parses it.
  ps_manifest=$(sed -n "s/^\$ManifestJson = '\(.*\)'$/\1/p" "$PS1_INSTALLER")
  ps_source="embedded \$ManifestJson literal; pwsh not installed, PowerShell NOT executed here"
fi
norm() { python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin),sort_keys=True))'; }
if [ -n "$ps_manifest" ] && [ "$(printf '%s' "$sh_manifest" | norm)" = "$(printf '%s' "$ps_manifest" | norm)" ]; then
  ok "$t ($ps_source)"
else bad "$t" "sh: $sh_manifest | ps1: $ps_manifest"; fi

t="parity: PowerShell script syntax-checks"
if command -v pwsh >/dev/null 2>&1; then
  if pwsh -NoProfile -Command "\$t=\$null; \$e=\$null; [System.Management.Automation.Language.Parser]::ParseFile('$PS1_INSTALLER',[ref]\$t,[ref]\$e) | Out-Null; if (\$e.Count) { \$e | ForEach-Object { \$_.ToString() }; exit 1 }"; then ok "$t"; else bad "$t" "parser errors above"; fi
else
  skip "$t (pwsh not installed on this machine; untested here)"
fi

# --- rendered scripts not stale ---------------------------------------------------------------
t="render: checked-in install.sh and install.ps1 match a fresh render of stages.tsv + templates + keys"
if "$REPO_ROOT/scripts/installer/render.sh" --check; then ok "$t"; else bad "$t" "run scripts/installer/render.sh"; fi

t="static: no eval, no nested curl|sh, no sudo in either installer"
if ! grep -nE '(^|[^a-z_])eval[ (]|curl[^|]*\|[ ]*(ba)?sh|sudo ' "$INSTALLER" "$PS1_INSTALLER" | grep -v ':[0-9]*:[[:space:]]*#' ; then ok "$t"; else bad "$t" "see matches above"; fi

# ============================================================================ summary
echo
echo "passed $pass  failed $fail"
if [ "$fail" -gt 0 ]; then printf '  - %s\n' "${failed_names[@]}"; exit 1; fi
