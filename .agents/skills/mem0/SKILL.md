---
name: mem0
description: Use when persisting development context, session states, configuration details, tested modules, or architectural decisions across multiple agent build sessions.
---

# Mem0 (Claude Mem) Development Memory

## Overview

Use Mem0 to maintain a persistent state record of completed features, testnet verification hashes, edge cases, and design constraints across build sessions.

## When to Use

Use this skill at the beginning, during, and at the end of every feature development session.

### session start
- Load and query Mem0/Claude Mem to recall the exact state of the project, including:
  - Complete and tested modules/connectors
  - Active/in-progress billing components
  - Decided database or ledger invariants
  - Active testnet transaction hashes used as fixtures
  - Rejected approaches or failed experiments

### during build
- As soon as a sub-task or atomic module is complete, record:
  - What was built and its exact purpose
  - Failure modes identified and addressed
  - Testnet transaction hashes used for validation
  - Unresolved edge cases to avoid breaking later

### session end
- Summarize the final session state in Mem0 and update the workspace `CLAUDE.md`.

## Quick Reference

| Action | Content to Query / Write |
|---|---|
| **Query at Start** | `"What wallet connectors are tested?"`, `"What are the ledger invariants?"` |
| **Record during build** | Module metadata, verified transaction hashes, edge cases, future dependencies. |
| **Commit at End** | Summary of work, next step dependencies (e.g. usage metering, ledger constraints). |

## Common Mistakes

- **Losing Session Context:** Forgetting to query Mem0 at session start, resulting in re-proposing rejected approaches or breaking completed invariants.
- **Vague Entries:** Storing generic messages like "implemented billing" instead of detailing the exact RPC keys, wallet validation criteria, or testnet hashes.
