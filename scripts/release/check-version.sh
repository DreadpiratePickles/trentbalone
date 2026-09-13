#!/usr/bin/env bash
# check-version.sh — the release version must equal CLI_VERSION and apps/cli/package.json.
#
#   scripts/release/check-version.sh <version>      # exit 0 if all three agree, 1 otherwise
#   scripts/release/check-version.sh                # print CLI_VERSION (after checking it against package.json)
#
# `trent --version` prints CLI_VERSION; the installer writes it to ~/.trent/current and the launcher
# runs versions/<CLI_VERSION>/trent, so a tag that does not match would install a binary that
# disagrees with its own directory name. Used by release.yml (preflight) and scripts/release/preflight.sh.
set -euo pipefail
REPO_ROOT="${TRENT_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
registry="$REPO_ROOT/apps/cli/src/commands/registry.ts"
pkg="$REPO_ROOT/apps/cli/package.json"
[ -f "$registry" ] || { echo "check-version: missing $registry" >&2; exit 1; }
[ -f "$pkg" ] || { echo "check-version: missing $pkg" >&2; exit 1; }

cli_version=$(sed -n 's/^export const CLI_VERSION = "\([^"]*\)";.*/\1/p' "$registry" | head -1)
[ -n "$cli_version" ] || { echo "check-version: CLI_VERSION not found in $registry" >&2; exit 1; }
pkg_version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -1)
[ -n "$pkg_version" ] || { echo "check-version: version not found in $pkg" >&2; exit 1; }

rc=0
if [ "$cli_version" != "$pkg_version" ]; then
  echo "check-version: CLI_VERSION ($cli_version) != apps/cli/package.json version ($pkg_version)" >&2; rc=1
fi
if [ $# -ge 1 ]; then
  want="${1#v}"
  if [ "$want" != "$cli_version" ]; then
    echo "check-version: release version $want != CLI_VERSION $cli_version (apps/cli/src/commands/registry.ts)" >&2; rc=1
  fi
  [ $rc -eq 0 ] && echo "check-version: OK v$want == CLI_VERSION == package.json"
else
  [ $rc -eq 0 ] && echo "$cli_version"
fi
exit $rc
