#!/usr/bin/env bash
# bundle-js.sh — produce apps/cli/dist/index.js, the file `apps/cli/package.json` `bin` points at.
#
# Before this existed, `bin` pointed at ./dist/index.js and the build script was `tsc --noEmit`,
# so dist was never produced and `npm i -g` installed a dangling binary.
#
# The bundle targets BUN, not Node: the store adapter is bun:sqlite and Bun's built-in `ws` is
# used by the transport layer. The shebang is rewritten to `bun` accordingly — running it under
# node fails with ERR_MODULE_NOT_FOUND('ws'), which is a truthful failure, not a silent one.
# The shippable artefact for end users is the compiled binary (scripts/build-cli.sh);
# this bundle is the npm-install path for people who already have Bun.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="$("$REPO_ROOT/scripts/build/resolve-bun.sh")"
ENTRY="apps/cli/src/index.ts"
OUT="apps/cli/dist/index.js"

[ -f "$ENTRY" ] || { echo "entry not found: $ENTRY" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"

echo "+ $BUN build --target=bun --outfile $OUT $ENTRY"
"$BUN" build --target=bun --outfile "$OUT" "$ENTRY"

[ -s "$OUT" ] || { echo "bundle reported success but produced no file at $OUT" >&2; exit 1; }

# Rewrite the inherited `#!/usr/bin/env node` shebang: this bundle needs Bun.
tmp="$(mktemp)"
{
  echo '#!/usr/bin/env bun'
  tail -n +2 "$OUT"
} > "$tmp"
mv "$tmp" "$OUT"
chmod +x "$OUT"

echo "bundled: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
