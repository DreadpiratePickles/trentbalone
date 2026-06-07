# Agent Plug Architecture

Agent Plug lets a company swap specialist profiles from the `agency-agents` catalog into Trent's nine operating slots without losing Trent's safety model.

## Core Idea

Each agent has three separate layers:

- Slot: Trent's responsibility seat, such as CEO, Engineer, Growth, Support, or Finance.
- Profile: the plugged specialist persona from the catalog, such as Backend Architect or Growth Hacker.
- Environment: the tools, memory namespace, budget, approval gates, runtime limits, and output contract available to that slot.

This keeps customization powerful without letting a profile accidentally gain unsafe permissions.

## Runtime Flow

1. User assigns a profile to one of the nine slots.
2. Trent stores an `AgentPlugAssignment` for `companyId + role`.
3. `getAgentRuntime(companyId, role)` composes:
   - Trent base safety prompt.
   - Slot contract mission and success metrics.
   - Plugged profile specialties and usage guidance.
   - Environment policy with tools, approval gates, budget, runtime, and outputs.
4. Operating cycles and agent executions use the runtime to tell each slot what job it owns and what environment it can act inside.

## Storage

Use `AgentPlugAssignment`, not string prefixes in `Agent.description`.

Assignment fields:

- `companyId`
- `role`
- `profileId`
- `profileSource`
- `environment`
- timestamps

Marketplace access uses `AgentEntitlement`.

Entitlement fields:

- `companyId`
- `productId`
- `profileId`
- `source`
- `status`
- `expiresAt`
- timestamps

The API still returns a simple `slots` map for Claude's frontend, but it now also returns `slotContracts`, `environments`, `runtimes`, and catalog access state.

## Marketplace

Trent has 9 executive operating seats. Agent Plug lets a company choose the specialist personality powering each seat.

The first marketplace pass supports:

- Included starter profiles that can be assigned without purchase.
- Locked premium profiles with product metadata.
- Category packs that unlock every profile in a catalog division.
- Mock purchase and revoke entitlements through `/api/agent-marketplace` until Stripe keys are configured.

Assignment enforcement lives in `/api/agent-plug`: a locked profile cannot be assigned until the company has an active entitlement for that profile or a pack that includes it.

Marketplace products include stable `stripeLookupKey` values so the mock product ids can later map to Stripe prices without changing the Agent Plug frontend contract.

## Environments

Environment defaults live in `lib/agent-catalog.ts` as `SLOT_ENVIRONMENTS`.

Every environment includes:

- `memoryNamespace`
- `tools`
- `approvalRequiredFor`
- `budgetCentsPerRun`
- `maxRuntimeSeconds`
- `outputContract`

Examples:

- Engineer can read GitHub, create issues, scaffold branches, and write docs. PRs, merges, deploys, and deletes require approval.
- Growth can draft email/social/ad work. Sending, publishing, launching, and spending require approval.
- Browser can do mocked research and screenshot planning. Login, submit, purchase, and download require approval.

## Next Work

- Import full agency-agent markdown files, not only README summaries.
- Expand the catalog from the current curated 61 entries toward the upstream 144+ agents.
- Replace mock marketplace purchases with Stripe products, checkout, subscriptions, and webhooks.
- Add admin grant/revoke tooling for entitlements.
- Add agent eval fixtures for every slot.
- Add task-level execution environments for code branches, browser sessions, Gmail drafts, and analytics.
- Add provider-specific environment overrides per company.
