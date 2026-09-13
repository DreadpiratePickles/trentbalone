#!/usr/bin/env bash
# assert-no-external.sh — fail the build if `--external` appears in any binary build command.
#
# WHY THIS EXISTS. `--external react-devtools-core` made `bun build --compile` exit 0 and
# produced a binary that died on launch, because Ink declares react-devtools-core as a peer
# dependency that npm does not install and the compiled binary has no node_modules to fall
# back to. The compile was green. The product was broken. `--external` is therefore banned
# outright as a build fix: if a module cannot be bundled, make it a real dependency or
# remove it from the import graph.
#
# Usage:  scripts/ci/assert-no-external.sh [extra files to scan...]
# Exit:   0 clean, 1 violation found.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TARGETS=(
  "scripts/ci/build-binary.sh"
  "scripts/build-cli.sh"
  "package.json"
  "apps/cli/package.json"
  "packages/trent-core/package.json"
  ".github/workflows"
)
TARGETS+=("$@")

echo "assert-no-external: scanning for the banned --external flag"
found=0

for t in "${TARGETS[@]}"; do
  [ -e "$t" ] || continue
  # -I skips binary files; --exclude-dir keeps us out of vendored trees.
  matches="$(grep -rInIH --exclude-dir=node_modules --exclude-dir=dist -e '--external' "$t" 2>/dev/null || true)"
  [ -n "$matches" ] && matches="$(
    printf '%s\n' "$matches" \
      | grep -v 'scripts/ci/assert-no-external.sh' \
      | awk -F: '{
          line = $0
          sub(/^[^:]*:[0-9]+:/, "", line)          # drop "file:lineno:"
          sub(/^[ \t]+/, "", line)                 # left-trim
          # A comment MENTIONING the ban is not a violation. Only live code is.
          if (line ~ /^(#|\/\/|\/\*|\*)/) next
          print $0
        }' || true
  )"
  if [ -n "$matches" ]; then
    printf '%s\n' "$matches"
    found=1
  fi
done

# Belt and braces: also inspect a build command handed in through the environment, so the
# guard covers a command assembled at runtime and not present in any file.
if [ -n "${TRENT_BUILD_COMMAND:-}" ]; then
  case "$TRENT_BUILD_COMMAND" in
    *--external*)
      echo "TRENT_BUILD_COMMAND contains --external: $TRENT_BUILD_COMMAND"
      found=1
      ;;
  esac
fi

if [ "$found" -ne 0 ]; then
  cat <<'EOF'

FAIL: --external is banned in binary build commands.
It previously produced a binary that compiled cleanly (exit 0) and died at runtime.
Fix the dependency instead: make it a real `dependencies` entry, or remove it from the
CLI import graph. Do not re-add the flag.
EOF
  exit 1
fi

echo "assert-no-external: PASS - no --external flag found"
exit 0
