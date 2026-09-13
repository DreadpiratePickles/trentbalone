# Messaging gateway

The gateway lets an agent reach you on a messaging platform, and lets you answer an approval from
your phone. Eight adapters are implemented against each platform's real protocol, and each is tested
against a local server speaking that protocol. Live tests against the real services are gated behind
`TRENT_TEST_LIVE=1` plus a per-platform credential and skip without one.

```bash
npm run cli -- gateway status
npm run cli -- gateway setup telegram --token <token>
npm run cli -- gateway start
npm run cli -- gateway start --dry-run
```

## Platform status

| Platform | Secret it reads | Transport (`packages/trent-core/src/gateway/platforms/`) |
|---|---|---|
| telegram | `TELEGRAM_BOT_TOKEN` | Bot API over HTTPS; inline keyboards for approvals |
| discord | `DISCORD_BOT_TOKEN` | Gateway WebSocket |
| slack | `SLACK_BOT_TOKEN` | Web API plus Socket Mode WebSocket; Block Kit messages |
| whatsapp | `WHATSAPP_TOKEN` | Graph API |
| signal | `SIGNAL_NUMBER` | signal-cli JSON-RPC and SSE |
| email | `EMAIL_SMTP_*` | Own thin SMTP and IMAP clients |
| teams | `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID` | Microsoft Graph with OAuth token fetch |
| homeassistant | — | REST notify services and webhooks |

Each adapter has a `*.wire.test.ts` (local HTTP, WebSocket or TCP server speaking the platform's
protocol) and a `*.live.test.ts`. The registry test asserts exactly these eight platforms. Around
the adapters sit a durable file-backed gateway store (queue, pairing and approval rows), device
pairing (default deny, random codes with a one-hour expiry, rate limited, admin and regular tiers),
a per-platform circuit breaker and health, and approvals that are checked against the durable row so
a forged or replayed callback is rejected.

## What does work

`gateway status` reads the profile secrets and reports, per platform, whether the credential is
present and which agent is designated to handle it:

```
MESSAGING GATEWAY
  not set   telegram       ceo
  not set   discord        ceo
  not set   slack          ceo
  ...
```

`gateway setup <platform> --token <token>` writes the credential into the profile's `.env` and
returns the name of the secret it configured, never the value.

Routing configuration is real. `gateway.routes` in `config.yaml` maps a platform id to an agent id,
and `gateway.platforms` lists the enabled ones. An incoming message is dispatched to the designated
agent's context.

## The approval bridge

`packages/trent-core/src/gateway/ApprovalBridge.ts` exists and is wired to the approval gate, which
is durable and survives a restart. See [security.md](security.md) for how approvals persist.
Approvals also work in the REPL and the TUI.

## Not yet implemented

- A published run against every live platform. The live tests exist but skip without credentials;
  only the wire tests run in CI.
- A `gateway` check in `trent doctor` that probes a configured platform end to end.
