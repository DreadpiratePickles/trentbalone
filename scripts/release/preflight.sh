#!/usr/bin/env bash
# preflight.sh — everything to check BEFORE creating the tag that triggers release.yml.
#
#   scripts/release/preflight.sh [--version <x.y.z>]     # exit 0 = safe to tag
#
# Checks, in order; every one runs and the summary lists every failure:
#   1. clean working tree (nothing unstaged, unstaged or untracked would be missing from the tag)
#   2. version == CLI_VERSION == apps/cli/package.json (scripts/release/check-version.sh)
#   3. tag v<version> does not already exist
#   4. committed public keys present; private keys NOT tracked
#   5. rendered installers match a fresh render (scripts/installer/render.sh --check)
#   6. gh is authenticated (gh auth status)
#   7. repository secrets TRENT_MINISIGN_KEY and TRENT_ECDSA_KEY exist (gh secret list)
#   8. no release v<version> exists yet
#   9. CI is green on HEAD (every check run on the commit completed with success/neutral/skipped)
#
# Env: TRENT_REPO_ROOT (default: this checkout), TRENT_REPO (default: parsed from `origin`).
# Only `gh` and `git` are called; the test (preflight.test.sh) substitutes a stub `gh` on PATH.
set -uo pipefail
REPO_ROOT="${TRENT_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT" || exit 2

want=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) want="${2#v}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "preflight: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

pass=0; fail=0; failed_names=()
ok()  { pass=$((pass+1)); printf 'PASS  %s\n' "$1"; }
bad() { fail=$((fail+1)); failed_names+=("$1"); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# --- 1 clean tree
t="clean working tree"
dirty=$(git status --porcelain --untracked-files=all 2>&1 || echo "git status failed")
if [ -z "$dirty" ]; then ok "$t"; else bad "$t" "$(printf '%s' "$dirty" | head -5 | tr '\n' ';')"; fi

# --- 2 version
cli_version=$(bash scripts/release/check-version.sh 2>/dev/null || true)
[ -n "$want" ] || want="$cli_version"
t="version $want == CLI_VERSION == apps/cli/package.json"
if out=$(bash scripts/release/check-version.sh "$want" 2>&1); then ok "$t"; else bad "$t" "$out"; fi

# --- 3 tag not taken
t="tag v$want does not exist yet"
if [ -z "$want" ]; then bad "$t" "no version"
elif [ -n "$(git tag -l "v$want")" ]; then bad "$t" "git tag v$want already exists locally (git tag -d v$want if it was a mistake)"
else ok "$t"; fi

# --- 4 keys
t="public keys committed, private keys not tracked"
keys=scripts/installer/keys
if [ ! -s "$keys/minisign.pub" ] || [ ! -s "$keys/ecdsa-p256.pub.pem" ]; then bad "$t" "missing $keys/minisign.pub or ecdsa-p256.pub.pem"
elif [ -n "$(git ls-files "$keys/minisign.key" "$keys/ecdsa-p256.key.pem")" ]; then bad "$t" "a PRIVATE key is tracked by git ($(git ls-files "$keys/minisign.key" "$keys/ecdsa-p256.key.pem" | tr '\n' ' ')); remove it from history and rotate (node $keys/gen-keys.mjs --force)"
else ok "$t"; fi

# --- 5 render
t="scripts/install.sh and install.ps1 match a fresh render"
if out=$(sh scripts/installer/render.sh --check 2>&1); then ok "$t"; else bad "$t" "$out (run scripts/installer/render.sh and commit)"; fi

# --- 6 gh auth
t="gh is authenticated"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then ok "$t"; else bad "$t" "gh auth login"; fi

# --- repo slug for the API calls
repo="${TRENT_REPO:-}"
if [ -z "$repo" ]; then
  origin=$(git remote get-url origin 2>/dev/null || true)
  repo=$(printf '%s' "$origin" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
fi

# --- 7 secrets
t="repository secrets TRENT_MINISIGN_KEY and TRENT_ECDSA_KEY exist"
secrets=$(gh secret list --repo "$repo" 2>/dev/null || true)
missing=""
for s in TRENT_MINISIGN_KEY TRENT_ECDSA_KEY; do printf '%s\n' "$secrets" | grep -q "^${s}[[:space:]]" || missing="$missing $s"; done
if [ -z "$missing" ]; then ok "$t"; else bad "$t" "missing:$missing (gh secret set <NAME> < scripts/installer/keys/<file>)"; fi

# --- 8 no existing release
t="no release v$want exists"
if gh release view "v$want" --repo "$repo" >/dev/null 2>&1; then bad "$t" "release v$want already exists; bump the version"; else ok "$t"; fi

# --- 9 CI green on HEAD
sha=$(git rev-parse HEAD)
t="CI green on HEAD ($sha)"
runs=$(gh api "repos/$repo/commits/$sha/check-runs" --paginate --jq '.check_runs[] | "\(.status)\t\(.conclusion)\t\(.name)"' 2>&1) || runs="ERROR $runs"
case "$runs" in
  ERROR*) bad "$t" "could not list check runs: ${runs#ERROR }" ;;
  "") bad "$t" "no check runs on $sha (is HEAD pushed? did CI run?)" ;;
  *)
    notgreen=$(printf '%s\n' "$runs" | awk -F'\t' '!($1=="completed" && ($2=="success"||$2=="neutral"||$2=="skipped")) { print $3" ("$1"/"$2")" }')
    if [ -z "$notgreen" ]; then ok "$t ($(printf '%s\n' "$runs" | wc -l | tr -d ' ') check runs)"; else bad "$t" "$(printf '%s' "$notgreen" | tr '\n' ';')"; fi ;;
esac

echo
echo "passed $pass  failed $fail"
if [ "$fail" -gt 0 ]; then printf '  - %s\n' "${failed_names[@]}"; exit 1; fi
echo "ready: git tag -a v$want -m '<release notes>' && git push origin v$want"
