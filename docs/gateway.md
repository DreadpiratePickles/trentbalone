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
and `gateway.platforms` lists the enabled ones.

`gateway start` builds the same headless runtime the REPL runs on (`apps/cli/src/runtime/headless.ts`:
store, toolsets, egress proxy, fleet memory, the improve loop, the orchestrator) and installs an
agent handler on the manager (`apps/cli/src/gateway/agent-handler.ts`). A message from a paired
sender becomes one orchestrated run with `trigger: "manual"`; the reply is that run's consolidated
summary as carried by `consolidate_end` / `run_done`, or the reason a `run_failed` frame carries.
A run that ends with neither sends nothing. The route's agent id is recorded on the manager but the
run is planned by the orchestrator, which picks the seats. `--dry-run` builds no runtime and reports
which platforms would start. When no platform has a credential the command releases the runtime and
exits; otherwise it stays up, and SIGTERM or SIGHUP stops the adapters, the proxy and the sandboxes
before the process exits. Ctrl+C is answered by the binary itself and exits at once.

## The approval bridge

`packages/trent-core/src/gateway/ApprovalBridge.ts` is wired to the approval gate, which is durable
and survives a restart. See [security.md](security.md) for how approvals persist. Approvals also
work in the REPL and the TUI.

A gated step on a run started from chat reaches you as a card when `gateway.owner` is set:

```yaml
gateway:
  owner:
    platform: telegram
    channelId: "555"
```

`packages/trent-core/src/gateway/RunApprovalLink.ts` observes the run's events: on
`step_awaiting_approval` / `run_awaiting_approval` it creates one approval row carrying `runId` and
`stepId` (the bus emits both frames for one gate; the second is not sent again) and queues the card
to the owner through `GatewayManager.sendApproval`. The owner's decision — a button or an
`APPROVE <id> <nonce>` reply, checked against the durable row and the admin pairing — releases the
step through `orchestrator.approve` / `orchestrator.reject`, once per card. Without `gateway.owner`
the link is off: `gateway start` says so in its report and writes one structured log line, and a
gated run stays parked until it is answered from the REPL or the TUI.

## Not yet implemented

- A published run against every live platform. The live tests exist but skip without credentials;
  only the wire tests run in CI.
- A `gateway` check in `trent doctor` that probes a configured platform end to end.
- Cards for gates on runs the gateway did not start (a REPL or cron run): only runs the agent
  handler starts are observed by the link.
- A clean release of the runtime on Ctrl+C: `apps/cli/src/index.ts` exits on SIGINT before the
  gateway's shutdown runs. Use SIGTERM for a graceful stop.
