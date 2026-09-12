---
name: n8n-mcp
description: Use when orchestrating asynchronous external event triggers, payment confirmations, timed hold period releases, price feed monitors, or manual escalations via n8n workflows.
---

# n8n-MCP Event Orchestration

## Overview

Use n8n as the asynchronous event orchestrator to trigger Trent modules in response to external events (e.g. onchain transactions, timeouts, price alerts). 

> [!IMPORTANT]
> **Security Boundary:** n8n must never hold private keys or execute transactions directly. n8n triggers Trent modules, which construct unsigned transactions for the user to sign via MetaMask/Phantom.

## Trigger Workflows

### 1. Payment Confirmation Flow
- n8n monitors EVM/Solana RPC nodes for incoming USDC transfers.
- On detection, n8n calls Trent's billing endpoints (e.g., `erc20-billing.ts` or `spl-billing.ts`) with the transaction hash and amount.
- Trent validates onchain, matches the invoice, updates subscriptions, and logs to the ledger.

### 2. Hold Period Expiry
- n8n triggers a hourly check.
- When a payout hold expires, n8n triggers `payout-router.ts`.
- The router prepares an unsigned transfer transaction and posts a human approval card to the approvals UI.

### 3. Price Feed Staleness Alerts
- n8n monitors Pyth and Chainlink update timestamps.
- If updates lag beyond the threshold (e.g. 60s for Pyth), n8n triggers an alert in Trent and pauses dependent billing events.

### 4. Dispute Escalation
- n8n flags anomalous transactions or processes manual chargeback requests.
- n8n triggers `dispute-handler.ts` to surface a human approval card in the UI.

## Common Mistakes

- **Key Custody in n8n:** Storing private keys or signing transactions directly in n8n nodes. All signing MUST happen client-side in the user's wallet.
- **Bypassing Trent Modules:** Writing custom database updates or ledger inserts inside n8n workflow steps. n8n must only invoke Trent's API endpoints.
