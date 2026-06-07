---
name: lightrag
description: Use when querying codebase dependencies, mapping architectural boundaries, detecting coupling violations, or preparing for downstream phase integrations.
---

# LightRAG Codebase Dependency Mapping

## Overview

Use LightRAG to map, query, and enforce clean architectural boundaries across the codebase. LightRAG enables structural searches of dependencies, preventing tight coupling between Capabilites, Providers, and Ledger modules.

## When to Use

### before building
- Load existing dependency files (e.g. `lib/rls.ts`, `lib/secrets.ts`, `lib/spend.ts`, `lib/workbench.ts`, `app/api/audit/route.ts`) into LightRAG.
- Query constraints and dependencies to ensure the new module adheres to established patterns.

### during build
- Add newly created files to the LightRAG index.
- Query to identify unexpected or circular imports (e.g., verifying the `payout-router.ts` interacts only with the `ledger.ts` API rather than querying connectors directly).

### phase transition
- Query LightRAG to trace all affected components for the next phase:
  `"Which Phase 2 modules does Phase 3 infra provisioning touch?"`

## Quick Reference

| Query Objective | Example Query |
|---|---|
| **Constraint Tracing** | `"What does the ledger depend on?"` |
| **Coupling Verification** | `"What modules write to the ledger?"` |
| **Boundary Check** | `"What is the credential boundary between the payout router and agent runtime?"` |

## Common Mistakes

- **Direct Coupling:** Allowing modules to skip layers (e.g. payout router calling wallet connectors directly) instead of using the intermediate ledger API. Use LightRAG query to audit imports.
- **Out-of-Date Index:** Forgetting to add new modules to LightRAG, leading to incomplete dependency queries for subsequent phases.
