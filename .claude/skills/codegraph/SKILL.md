---
name: codegraph
description: Use semantic code intelligence for fast architecture discovery, dependency mapping, and targeted file access during audits and implementation planning.
---

# CodeGraph

Use CodeGraph when you need structure-aware project inspection instead of manual file-walk + grep loops.

## Core Workflow

1. Ensure the project is indexed:
   - `npx @colbymchenry/codegraph init -i`
   - or from within the repo, run `npx @colbymchenry/codegraph status` to verify index freshness.
2. Prefer symbol-level lookup over raw discovery:
   - `npx @colbymchenry/codegraph query <symbol-or-topic> --limit <n>`
3. For multi-file analysis, use:
   - `npx @colbymchenry/codegraph context "<task description>"`
4. For blast-radius checks before edits:
   - use `context`, then targeted file reads on exact matches.

## Commands

- `npx @colbymchenry/codegraph status`
- `npx @colbymchenry/codegraph files --max-depth 2`
- `npx @colbymchenry/codegraph query withRlsContext`
- `npx @colbymchenry/codegraph query checkAuthRateLimit`
- `npx @colbymchenry/codegraph query ledger`
- `npx @colbymchenry/codegraph context "trace tenant isolation in API routes"`

## Notes

- Keep `.codegraph/` generated artifacts out of PRs unless explicitly requested.
- Do not infer behavior from index hits; always verify with source lines before claiming correctness.
