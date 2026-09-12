#!/usr/bin/env bash
# resolve-bun.sh — print the absolute path of the bun binary, or fail with an actionable message.
#
# Order: $TRENT_BUN_BIN -> PATH -> ~/.bun/bin/bun. A non-login shell (CI step, npm script, hook)
# frequently does not have ~/.bun/bin on PATH, which is why the third fallback exists.
#
# Usage:  BUN="$(scripts/build/resolve-bun.sh)"

set -euo pipefail

candidates=()
[ -n "${TRENT_BUN_BIN:-}" ] && candidates+=("$TRENT_BUN_BIN")
if command -v bun >/dev/null 2>&1; then candidates+=("$(command -v bun)"); fi
candidates+=("$HOME/.bun/bin/bun")

for c in "${candidates[@]}"; do
  if [ -x "$c" ]; then
    printf '%s\n' "$c"
    exit 0
  fi
done

cat >&2 <<EOF
FAIL: no usable bun binary.

Looked, in order, at:
  \$TRENT_BUN_BIN   ${TRENT_BUN_BIN:-<unset>}
  PATH             $(command -v bun 2>/dev/null || echo '<not on PATH>')
  \$HOME/.bun/bin   $HOME/.bun/bin/bun

Fix one of these:
  export TRENT_BUN_BIN=/absolute/path/to/bun
  export PATH="\$HOME/.bun/bin:\$PATH"
  curl -fsSL https://bun.sh/install | bash     # then re-run

The Trent CLI is compiled with \`bun build --compile\`; there is no Node fallback,
because the store adapter is bun:sqlite.
EOF
exit 1
