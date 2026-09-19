#!/bin/zsh
# Usage: isolate.sh <tests...> -- <files...>   (files = repo-relative paths to copy from the working tree onto a clean HEAD worktree)
set -u
ROOT=$(git rev-parse --show-toplevel)
S=${TRENT_DEV_SCRATCH:-/tmp/trent-dev}; mkdir -p $S
WT=$S/wt
export TRENT_QUEUE_FALLBACK=disabled
TESTS=(); FILES=(); mode=t
for a in "$@"; do if [ "$a" = "--" ]; then mode=f; continue; fi; if [ $mode = t ]; then TESTS+=("$a"); else FILES+=("$a"); fi; done
if [ ! -d $WT ]; then git -C $ROOT worktree add -q --detach $WT HEAD || exit 9; else git -C $WT reset -q --hard && git -C $WT clean -qfd && git -C $WT checkout -q --detach $(git -C $ROOT rev-parse HEAD) && git -C $WT reset -q --hard; fi
for d in node_modules apps/web/node_modules apps/cli/node_modules; do [ -e $WT/$d ] || ln -s $ROOT/$d $WT/$d; done
( cd $WT && npx prisma generate --schema packages/trent-core/prisma/schema.sqlite.prisma >/dev/null 2>&1 ) || echo "prisma generate (core) failed"
for spec in "${FILES[@]}"; do f=${spec%%=*}; src=$ROOT/$f; [ "$spec" != "$f" ] && src=${spec#*=}; mkdir -p $WT/$(dirname $f); if [ -e $src ]; then rm -rf $WT/$f; cp -R $src $WT/$f; else rm -rf $WT/$f; fi; done
find $WT/apps $WT/packages -type d -empty -not -path "*/node_modules/*" -delete 2>/dev/null
cd $WT
rc=0
npx tsc --noEmit -p apps/cli/tsconfig.json; r=$?; echo "tsc exit=$r"; [ $r -ne 0 ] && rc=1
npm --prefix packages/trent-core run build >/dev/null 2>&1; r=$?; echo "core build exit=$r"; [ $r -ne 0 ] && rc=1
node scripts/ci/repo-scan.mjs >/dev/null 2>&1; r=$?; echo "repo-scan exit=$r"; [ $r -ne 0 ] && rc=1
if [ ${#TESTS[@]} -gt 0 ]; then npx vitest run "${TESTS[@]}" --reporter=dot > $S/wt-vitest.log 2>&1; r=$?; grep -E "^ FAIL |Test Files|Tests " $S/wt-vitest.log | sed "s/ >.*//" | sort -u | head -30; echo "vitest exit=$r"; [ $r -ne 0 ] && rc=1; fi
echo "ISOLATED rc=$rc"
exit $rc
