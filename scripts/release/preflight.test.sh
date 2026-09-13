#!/usr/bin/env bash
# preflight.test.sh — behavioural tests for scripts/release/preflight.sh.
#
# Each test runs the real preflight against a throwaway git repository containing the real
# installer sources (render.sh, templates, public keys) and a stub `gh` on PATH whose answers are
# set per test through environment variables. Nothing here greps preflight.sh to decide whether
# it works; every assertion is on its exit code and the PASS/FAIL lines it prints.
#
#   scripts/release/preflight.test.sh      # exit 0 = every test passed
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/trent-preflight-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0; failed_names=()
ok()  { pass=$((pass+1)); printf 'PASS  %s\n' "$1"; }
bad() { fail=$((fail+1)); failed_names+=("$1"); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# ------------------------------------------------------------------ stub gh
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Stub gh: behaviour comes from STUB_* variables. Records every invocation in $STUB_LOG.
printf '%s\n' "$*" >> "${STUB_LOG:-/dev/null}"
case "$1 $2" in
  "auth status")   [ "${STUB_AUTH:-ok}" = ok ] && exit 0 || exit 1 ;;
  "secret list")   printf '%b' "${STUB_SECRETS:-TRENT_ECDSA_KEY\t2026-09-13T15:35:16Z\nTRENT_MINISIGN_KEY\t2026-09-13T15:35:16Z\n}"; exit 0 ;;
  "release view")  [ "${STUB_RELEASE_EXISTS:-0}" = 1 ] && exit 0 || { echo "release not found" >&2; exit 1; } ;;
  "api "*)         if [ "${STUB_API_FAIL:-0}" = 1 ]; then echo "gh: No commit found (HTTP 422)" >&2; exit 1; fi
                   printf '%b' "${STUB_CHECKS-completed\tsuccess\tci / test\ncompleted\tsuccess\tbinaries / RUN trent-linux-x64\n}"; exit 0 ;;
  *) echo "stub gh: unhandled: $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$WORK/bin/gh"

# ------------------------------------------------------------------ fixture repo
# A minimal tree with everything preflight touches, committed, with an `origin` that names a repo.
fixture() { # $1 dir, $2 version
  local dir="$1" v="$2"
  mkdir -p "$dir/apps/cli/src/commands" "$dir/scripts/release" "$dir/scripts/installer"
  cp -R "$REPO_ROOT/scripts/installer/." "$dir/scripts/installer/"
  rm -f "$dir/scripts/installer/keys/minisign.key" "$dir/scripts/installer/keys/ecdsa-p256.key.pem"
  cp "$REPO_ROOT/scripts/release/preflight.sh" "$REPO_ROOT/scripts/release/check-version.sh" "$dir/scripts/release/"
  printf 'export const CLI_VERSION = "%s";\n' "$v" > "$dir/apps/cli/src/commands/registry.ts"
  printf '{\n  "name": "@trent/cli",\n  "version": "%s"\n}\n' "$v" > "$dir/apps/cli/package.json"
  sh "$dir/scripts/installer/render.sh" --out "$dir/scripts" >/dev/null
  ( cd "$dir" && git init -q && git config user.email t@t && git config user.name t \
    && git remote add origin https://github.com/example/fixture.git \
    && git add -A && git commit -qm fixture )
}

run() { # $1 dir, then env assignments; prints output, returns preflight's exit code
  local dir="$1"; shift
  ( cd "$dir" && env PATH="$WORK/bin:$PATH" STUB_LOG="$WORK/gh.log" TRENT_REPO_ROOT="$dir" "$@" bash scripts/release/preflight.sh ) 2>&1
}

fixture "$WORK/good" 1.2.3

# --- green path -------------------------------------------------------------------------------
t="all checks pass on a clean, matching, green fixture -> exit 0"
: > "$WORK/gh.log"
if out=$(run "$WORK/good") && printf '%s' "$out" | grep -q 'passed 9  failed 0' && printf '%s' "$out" | grep -q 'git tag -a v1.2.3'; then ok "$t"; else bad "$t" "$out"; fi

t="gh is asked about the repo parsed from origin (example/fixture), not a hard-coded slug"
if grep -q 'secret list --repo example/fixture' "$WORK/gh.log" && grep -q 'api repos/example/fixture/commits/' "$WORK/gh.log"; then ok "$t"; else bad "$t" "$(cat "$WORK/gh.log")"; fi

t="--version must match CLI_VERSION -> FAIL on 9.9.9"
out=$(cd "$WORK/good" && env PATH="$WORK/bin:$PATH" TRENT_REPO_ROOT="$WORK/good" bash scripts/release/preflight.sh --version 9.9.9 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'FAIL  version 9.9.9'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

# --- each failure is detected on its own ------------------------------------------------------
t="dirty working tree -> FAIL clean working tree"
echo scratch > "$WORK/good/untracked.txt"
out=$(run "$WORK/good") && rc=0 || rc=$?
rm -f "$WORK/good/untracked.txt"
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'FAIL  clean working tree' && printf '%s' "$out" | grep -q 'untracked.txt'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="existing tag -> FAIL tag exists"
( cd "$WORK/good" && git tag v1.2.3 )
out=$(run "$WORK/good") && rc=0 || rc=$?
( cd "$WORK/good" && git tag -d v1.2.3 >/dev/null )
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'FAIL  tag v1.2.3 does not exist yet'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="stale rendered installer -> FAIL render check"
( cd "$WORK/good" && echo '# stale' >> scripts/install.sh && git commit -qam stale )
out=$(run "$WORK/good") && rc=0 || rc=$?
( cd "$WORK/good" && git reset -q --hard HEAD~1 )
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'FAIL  scripts/install.sh and install.ps1 match'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="tracked private key -> FAIL keys check"
( cd "$WORK/good" && echo 'untrusted comment: fake' > scripts/installer/keys/minisign.key && git add -f scripts/installer/keys/minisign.key && git commit -qm leak )
out=$(run "$WORK/good") && rc=0 || rc=$?
( cd "$WORK/good" && git reset -q --hard HEAD~1 && rm -f scripts/installer/keys/minisign.key )
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'FAIL  public keys committed, private keys not tracked'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="gh not authenticated -> FAIL gh auth"
out=$(run "$WORK/good" STUB_AUTH=no) && rc=0 || rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'FAIL  gh is authenticated'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="missing TRENT_MINISIGN_KEY secret -> FAIL names the missing secret"
out=$(run "$WORK/good" STUB_SECRETS='TRENT_ECDSA_KEY\t2026-09-13\n') && rc=0 || rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'missing: TRENT_MINISIGN_KEY'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="release already published -> FAIL no release exists"
out=$(run "$WORK/good" STUB_RELEASE_EXISTS=1) && rc=0 || rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'FAIL  no release v1.2.3 exists'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="a failed check run on HEAD -> FAIL CI green, naming the run"
out=$(run "$WORK/good" STUB_CHECKS='completed\tsuccess\tci / lint\ncompleted\tfailure\tbinaries / RUN trent-windows-x64.exe\n') && rc=0 || rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'FAIL  CI green' && printf '%s' "$out" | grep -q 'trent-windows-x64.exe (completed/failure)'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="an in-progress check run on HEAD is not green"
out=$(run "$WORK/good" STUB_CHECKS='in_progress\tnull\tci / test\n') && rc=0 || rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'ci / test (in_progress/null)'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="HEAD not on GitHub (API error) -> FAIL CI green with the API message"
out=$(run "$WORK/good" STUB_API_FAIL=1) && rc=0 || rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'could not list check runs'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="no check runs at all -> FAIL (a commit CI never saw is not green)"
out=$(run "$WORK/good" STUB_CHECKS='') && rc=0 || rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'no check runs on'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

t="CLI_VERSION != package.json -> FAIL version, even with no --version"
fixture "$WORK/mismatch" 2.0.0
( cd "$WORK/mismatch" && sed -i.bak 's/"2.0.0"/"2.0.1"/' apps/cli/package.json && rm apps/cli/package.json.bak && git commit -qam mismatch )
out=$(run "$WORK/mismatch") && rc=0 || rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'CLI_VERSION (2.0.0) != apps/cli/package.json version (2.0.1)'; then ok "$t"; else bad "$t" "rc=$rc $out"; fi

# ============================================================================ summary
echo
echo "passed $pass  failed $fail"
if [ "$fail" -gt 0 ]; then printf '  - %s\n' "${failed_names[@]}"; exit 1; fi
