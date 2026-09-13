# 2026-09-12 — Messaging gateway: real transports (task 7.1)

Scope: `packages/trent-core/src/gateway/**` only. No git operations in this session.

## Plan
1. Transport contract (`transport/types.ts`): start/stop/send/onMessage/health/capabilities.
2. Registry (`registry.ts`): one entry per platform; contract-conformance test over every entry.
3. Eight adapters, thin fetch/ws/tls clients, pinned API versions, base-URL injectable.
4. Durable gateway store (file-backed JSON, atomic write) for queue rows, pairing rows, approval rows.
5. Approvals enforced against the durable row; forged/replayed callbacks rejected.
6. Pairing: default deny, CSPRNG codes, 1h expiry, rate limit, admin/regular tiers per DM/group.
7. Queue + circuit breaker + per-platform health.
8. Wire tests: local HTTP/WS/TCP servers speaking each platform's real protocol. Live tests gated
   behind TRENT_TEST_LIVE=1 and a per-platform env var.

## Log
- Read task 7.1, Hermes findings, AGENTS.md, existing gateway (7 empty adapters, 1 map-keys test).
- CLI consumers to keep compatible: GatewayManager(getStatus/setRoute/getAgentForPlatform/
  startAllConfigured/stopAll), ApprovalBridge(createApprovalRequest/listPending/decide/on/getApproval).
- StorePort (Prisma on bun:sqlite) has approvals but no queue/pairing tables and runs only under Bun;
  gateway therefore owns a file-backed durable store and mirrors approvals into StorePort when given one.
- Core green: store, pairing (rate window separate from code TTL), approvals w/ nonce, breaker, queue.
- Added devDependencies to packages/trent-core: ws ^8.21.3, @types/ws ^8.18.1 (websocket test servers).
- Telegram, Slack, Discord, WhatsApp adapters green against local wire servers.
- Signal, Email (own SMTP/IMAP thin clients), Teams, Home Assistant adapters green.
- Registry + GatewayManager rewrite (pairing gate, routing, durable queue, breakers, approvals) + WebhookServer.
- Live tests generated per platform, gated TRENT_TEST_LIVE=1 + platform env var; all skip without tokens.
- Verification: `npx vitest run packages/trent-core/src/gateway` -> 14 files, 67 tests, exit 0.
  `npx tsc --noEmit -p packages/trent-core/tsconfig.json` -> exit 2, the single error is in
  src/orchestrator/orchestrator.defects.test.ts (untracked, being written by a concurrent task); 0 errors under gateway/.
- Not committed (per instruction). Files: packages/trent-core/src/gateway/**, packages/trent-core/package.json (ws, @types/ws dev), package-lock.json.
