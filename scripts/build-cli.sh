#!/usr/bin/env bash
# build-cli.sh — produce the shippable Trent CLI binaries.
#
# The previous version of this file ended every step with `|| true`, so a build that produced
# nothing exited 0 and printed "✓ Build complete". This one fails loudly on any error:
# set -euo pipefail, and every artefact is asserted to exist before it is checksummed.
#
# Usage:
#   scripts/build-cli.sh                 # all four targets
#   scripts/build-cli.sh darwin-arm64    # one target (short or full bun-* name)
#   scripts/build-cli.sh --list
#
# Env:
#   TRENT_BUN_BIN   absolute path to bun; otherwise PATH, otherwise ~/.bun/bin/bun
#   TRENT_DIST_DIR  output directory (default: dist)
#
# Pipeline per target:
#   assert-no-external  ->  bun build --compile  ->  scan-binary  ->  sha256
#
# Cross-compilation is NOT evidence that a binary runs. Only the host target is executed here;
# the other three are verified by object header and must be RUN by CI on their native OS
# (.github/workflows/binary.yml + scripts/ci/verify-binary.mjs).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ALL_TARGETS=(bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-windows-x64)
DIST="${TRENT_DIST_DIR:-$REPO_ROOT/dist}"

die() { echo "FAIL: $*" >&2; exit 1; }

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${ALL_TARGETS[@]}"
  exit 0
fi

# ---------------------------------------------------------------- target selection
targets=()
if [ "$#" -eq 0 ] || [ "${1:-}" = "all" ]; then
  targets=("${ALL_TARGETS[@]}")
else
  for arg in "$@"; do
    t="$arg"
    case "$t" in bun-*) ;; *) t="bun-$t" ;; esac
    found=0
    for known in "${ALL_TARGETS[@]}"; do [ "$t" = "$known" ] && found=1; done
    [ "$found" -eq 1 ] || die "unknown target '$arg'. Known: ${ALL_TARGETS[*]}"
    targets+=("$t")
  done
fi

# ------------------------------------------------------------------- toolchain
BUN="$("$REPO_ROOT/scripts/build/resolve-bun.sh")"
export PATH="$(dirname "$BUN"):$PATH"     # scripts/ci/build-binary.sh invokes plain `bun`
echo "bun: $BUN ($("$BUN" --version))"

command -v node >/dev/null 2>&1 || die "node is required for scripts/build/scan-binary.mjs"

# ------------------------------------------------------- rule 1: the peer dep trap
# Ink imports react-devtools-core, which npm does not install for a peer dependency.
# Marking it --external compiles green and dies at launch inside the compiled filesystem.
if ! node -e 'require.resolve("react-devtools-core/package.json")' >/dev/null 2>&1; then
  die "react-devtools-core is not installed. Ink imports it and npm does not install peers.
     Fix:  npm install --workspace=apps/cli react-devtools-core
     Do NOT mark it external: that compiles with exit 0 and dies at runtime."
fi
grep -q '"react-devtools-core"' apps/cli/package.json \
  || die "react-devtools-core must be a REAL dependency in apps/cli/package.json, not a peer."
echo "react-devtools-core: real dependency, resolvable"

# ------------------------------------------------------- rule 3: --external is banned
"$REPO_ROOT/scripts/ci/assert-no-external.sh"

# ------------------------------------------------------------------------ build
mkdir -p "$DIST"
: > "$DIST/.build-manifest"
total=0

for target in "${targets[@]}"; do
  suffix="${target#bun-}"
  out="$DIST/trent-$suffix"
  [ "$suffix" = "windows-x64" ] && out="$out.exe"

  echo
  echo "=== $target -> $out"
  rm -f "$out"

  # The compile command lives in exactly one file so the --external guard has one place to
  # police. Do not inline `bun build --compile` here.
  "$REPO_ROOT/scripts/ci/build-binary.sh" "$target" "$out"

  [ -f "$out" ] || die "$target: build exited 0 but produced no file at $out"

  # rule 2: no native addons / foreign object headers inside the artefact.
  node "$REPO_ROOT/scripts/build/scan-binary.mjs" "$target" "$out"

  size=$(wc -c < "$out" | tr -d ' ')
  total=$((total + size))
  printf '%s\t%s\t%s\n' "$target" "$(basename "$out")" "$size" >> "$DIST/.build-manifest"
done

# -------------------------------------------------------------------- checksums
cd "$DIST"
sums=()
while IFS=$'\t' read -r _t name _s; do sums+=("$name"); done < .build-manifest
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${sums[@]}" > SHA256SUMS
else
  shasum -a 256 "${sums[@]}" > SHA256SUMS
fi
rm -f .build-manifest
cd "$REPO_ROOT"

# ----------------------------------------------------------------------- report
echo
echo "=== artefacts in $DIST"
printf '%-28s %12s  %s\n' "FILE" "BYTES" "MiB"
for target in "${targets[@]}"; do
  suffix="${target#bun-}"
  f="trent-$suffix"; [ "$suffix" = "windows-x64" ] && f="$f.exe"
  s=$(wc -c < "$DIST/$f" | tr -d ' ')
  printf '%-28s %12s  %s\n' "$f" "$s" "$(awk -v b="$s" 'BEGIN{printf "%.1f", b/1048576}')"
done
printf '%-28s %12s  %s\n' "TOTAL" "$total" "$(awk -v b="$total" 'BEGIN{printf "%.1f", b/1048576}')"
echo
cat "$DIST/SHA256SUMS"
echo
echo "OK. Cross-compiled artefacts are NOT proven to run — CI must execute each on its own OS"
echo "   (scripts/ci/verify-binary.mjs)."
