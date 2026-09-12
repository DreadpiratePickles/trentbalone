# Messaging gateway

The gateway is meant to let an agent reach you on a messaging platform, and let you answer an
approval from your phone. Read the status table below before planning around it: one adapter of eight
has any implementation, and none of them send a message yet.

```bash
npm run cli -- gateway status
npm run cli -- gateway setup telegram --token <token>
npm run cli -- gateway start
npm run cli -- gateway start --dry-run
```

## Platform status

| Platform | Secret it reads | Adapter state |
|---|---|---|
| telegram | `TELEGRAM_BOT_TOKEN` | Tracks configured and running state. `sendMessage` has no body |
| discord | `DISCORD_BOT_TOKEN` | Stub. `start`, `stop`, `sendMessage`, `onMessage` are all empty |
| slack | `SLACK_BOT_TOKEN` | Stub |
| whatsapp | `WHATSAPP_TOKEN` | Stub |
| signal | `SIGNAL_NUMBER` | Stub |
| email | `EMAIL_SMTP_*` | Stub |
| teams | `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID` | Stub |
| homeassistant | — | Stub |

"Stub" means the class exists, implements the `PlatformAdapter` interface, and correctly reports
whether its credential is present — and its `start`, `stop`, `sendMessage` and `onMessage` methods
have empty bodies. `gateway start` will report those platforms as started. Nothing will arrive.

This is a known anti-pattern in this project's own checklist: seven adapters with empty method
bodies previously passed their tests. The tests are the reason the state is visible; the
implementations are outstanding work.

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
and `gateway.platforms` lists the enabled ones. An incoming message would be dispatched to the
designated agent's context; nothing delivers one yet.

## The approval bridge

`packages/trent-core/src/gateway/ApprovalBridge.ts` exists and is wired to the approval gate, which
is durable and survives a restart. See [security.md](security.md) for how approvals persist. Since no
adapter can send a message, an approval card cannot currently reach a phone. Approvals work in the
REPL and the TUI.

## Not yet implemented

- Sending or receiving a message on any platform.
- Interactive approval cards, inline keyboards, Slack modals, Discord thread mapping.
- Device pairing.
- Anything reachable from a phone.
