#!/usr/bin/env bash
# build-binary.sh — cross-compile one Trent CLI binary with `bun build --compile`.
#
# This is the ONLY place the build command lives, so the --external guard has a single file
# to police (see scripts/ci/assert-no-external.sh).
#
# Usage:  scripts/ci/build-binary.sh <bun-target> <output-path>
#   e.g.  scripts/ci/build-binary.sh bun-linux-x64 dist/binaries/trent-linux-x64
#
# Targets: bun-darwin-arm64 | bun-darwin-x64 | bun-linux-x64 | bun-windows-x64
#
# Cross-compilation is NOT evidence of a working binary. Every artifact this script emits
# must be executed on its own operating system by the run-* jobs in .github/workflows/binary.yml.
# We learned that the hard way: a native module cross-compiled with exit 0 and produced a
# Linux ELF binary with macOS headers inside it.

set -euo pipefail

# ------------------------------------------------------------ preflight: generated clients
# The CLI bundles apps/web/lib, which imports the web app's Prisma client, and the store uses the
# derived SQLite client. Compiling without either bundles an uninitialised stub that compiles with
# exit 0 and dies on launch. Refuse up front rather than ship a binary that only fails on a user's
# machine. (Verified: a 41 MB binary that printed '@prisma/client did not initialize yet'.)
for client in "node_modules/.prisma/client/index.js" "packages/trent-core/src/store/generated/client.ts"; do
  if [ ! -e "$client" ]; then
    echo "build-binary: FAIL - generated Prisma client missing: $client" >&2
    echo "  run: npx prisma generate --schema apps/web/prisma/schema.prisma" >&2
    echo "  and: node packages/trent-core/scripts/derive-sqlite-schema.mjs" >&2
    exit 1
  fi
done


REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TARGET="${1:?usage: build-binary.sh <bun-target> <output-path>}"
OUTFILE="${2:?usage: build-binary.sh <bun-target> <output-path>}"
ENTRY="apps/cli/src/index.ts"

case "$TARGET" in
  bun-darwin-arm64|bun-darwin-x64|bun-linux-x64|bun-windows-x64) ;;
  *) echo "unsupported target: $TARGET" >&2; exit 2 ;;
esac

[ -f "$ENTRY" ] || { echo "entry not found: $ENTRY" >&2; exit 2; }

mkdir -p "$(dirname "$OUTFILE")"

# The build command. No --external. Ever. If a dependency will not bundle, fix the
# dependency; the guard below is a hard stop, not a warning.
BUILD_CMD=(bun build --compile --target="$TARGET" --outfile "$OUTFILE" "$ENTRY")

TRENT_BUILD_COMMAND="${BUILD_CMD[*]}" "$REPO_ROOT/scripts/ci/assert-no-external.sh"

echo "+ ${BUILD_CMD[*]}"
"${BUILD_CMD[@]}"

# bun appends .exe on windows targets whether or not the outfile already says so.
if [ ! -f "$OUTFILE" ] && [ -f "${OUTFILE}.exe" ]; then
  OUTFILE="${OUTFILE}.exe"
fi

[ -f "$OUTFILE" ] || { echo "build reported success but produced no file at $OUTFILE" >&2; exit 1; }
chmod +x "$OUTFILE" 2>/dev/null || true

echo "built: $OUTFILE ($(wc -c < "$OUTFILE" | tr -d ' ') bytes)"
