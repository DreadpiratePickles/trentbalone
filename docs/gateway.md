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

## Email: only an authenticated From gets through

`From:` is text the sender types, and pairing is keyed on it, so before an email is paired, routed
or read as an `APPROVE <id> <nonce>` reply, the adapter checks the receiving mail server's own
verdict (`packages/trent-core/src/gateway/platforms/email/auth-results.ts`). It reads one
`Authentication-Results` header: with `gateway.email.authserv_id` set, the first one whose
authserv-id (the token before the first `;`, RFC 8601 section 2.2) is that name, compared
case-insensitively, every other one being ignored as the sender's; without it, the topmost one.
It accepts `dmarc=pass` for the From domain or, when the server reports no DMARC policy, a
`dkim=pass` or an envelope-sender `spf=pass` whose domain is aligned with the From domain: equal,
or one inside the other (`bounces.example.com` for `example.com`); sibling subdomains never align.
`Received-SPF` names no server, so it is read only when `authserv_id` is unset and a message has no
`Authentication-Results` at all. Anything else (a DMARC fail, no verdict header, no header from the
named server, two `From:` headers) is marked seen and dropped with one log line naming the address
and the verdict, never the subject or body: no pairing code, no agent, no decision.

```yaml
gateway:
  email:
    require_authenticated_from: true
    authserv_id: mx.example.com   # the first token of your server's own Authentication-Results line
```

Set `authserv_id`; it is the recommended configuration. Unset, the topmost header decides, and the
check is only as strong as your server's habit of writing that header: on a server that skips it,
the topmost header would be the sender's own. To find the name, read the top
`Authentication-Results:` line of a message your server delivered; a server that omits the name
(its line starts with a result such as `spf=pass`) cannot be pinned, so leave `authserv_id` unset
there. `gateway.email.require_authenticated_from: false` restores the old behaviour, and a mail
server that strips the header, or never writes one, must opt out, since otherwise every message is
refused.

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
exits; otherwise it stays up, and Ctrl+C, SIGTERM or SIGHUP stops the heartbeat, the approval link,
the adapters, the proxy and the sandboxes before the process exits with 130. The command claims the
interrupt (`apps/cli/src/signals.ts`), so the binary's own Ctrl+C handler waits for that release
instead of exiting on top of it; a second Ctrl+C exits at once.

## One gateway per profile

Two `gateway start` on one profile used to attach every adapter twice, so each Telegram or Discord
message was answered twice. The manager now takes the profile's gateway lock before any adapter
starts (`packages/trent-core/src/profile/locks.ts`), and `gateway start` checks it before it builds
a runtime: a second start on the same profile exits 3 naming the running one's pid and starts
nothing. Different profiles may each run a gateway (`--profile work`), one per profile, several per
host.

The lock is `<profile>/locks/gateway.lock`, one JSON object `{ pid, startedAt, label, hostname }`,
mode 0600 in a 0700 directory, created with `O_EXCL` so of two racing starts exactly one wins. A
holder is alive while `kill(pid, 0)` succeeds or fails with `EPERM`; a dead pid (`ESRCH`), or a file
naming this process's own pid that it does not hold (a pid reused after a restart), is stale and
taken over. `stopAll`, Ctrl+C, SIGTERM and a normal exit release it; a process killed outright
leaves a file naming a dead pid, which the next start takes over. The hostname is shown, never used
to judge liveness, so one profile directory shared by two machines is not supported.

`gateway status` names the holder, and every other profile on this host with a gateway up (`--json`
carries them as `gateway` and `gateways`):

```
MESSAGING GATEWAY
  running   pid 75380 gateway since 2026-09-25T21:23:05.845Z
  also running on profile work: pid 75411
```

## Maintenance refuses under a live writer

The REPL, `gateway start`, `cron start`, `heartbeat start` and `trent run` (everything built on the
headless runtime) register their process as a writer on the profile for as long as they run:
`<profile>/locks/writers/<pid>.lock`, one file per process, its label listing the surfaces in it
(`repl`, `gateway`, `session+cron`). The commands that rewrite or delete profile state read that
set first and, while any other live process is in it, exit 3 naming each pid and label, having
touched nothing:

| Command | Why it refuses |
|---|---|
| `trent sessions prune` | deletes transcripts a live session may be appending to |
| `trent fleet import` | writes `trent.db`, the agents and skills directories and `config.yaml` |
| `trent doctor --fix` | rewrites modes, directories and config; plain `doctor` is read-only and never refuses |
| `trent uninstall` | deletes the profile; the default profile's directory is the base directory, so every profile's writers count |

```
error: sessions.prune: refusing: another process is writing this profile: pid 75875 (session+cron); stop it first, or pass --force (<profile>/locks/writers)
  exit code: 3
```

`--force` on each goes ahead after one `warning:` line naming the writers. A writer file naming a
dead pid never blocks, and the next writer to start removes it. The command's own process never
blocks itself. `trent brain import` and `brain forget` are not maintenance: they are the founder's
writes through the brain's one write path, which already serialises with seat writes under the
memory lock, so they do not refuse.

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

`packages/trent-core/src/gateway/RunApprovalLink.ts` rides on the headless runtime's bus hooks
(`HeadlessRuntimeDeps.busHooks`, composed with the improve loop and telemetry), so it sees every run
the runtime executes, whichever surface started it. On
`step_awaiting_approval` / `run_awaiting_approval` it creates one approval row carrying `runId` and
`stepId` (the bus emits both frames for one gate; the second is not sent again) and queues the card
to the owner through `GatewayManager.sendApproval`. The owner's decision — a button or an
`APPROVE <id> <nonce>` reply, checked against the durable row and the admin pairing — releases the
step through `orchestrator.approve` / `orchestrator.reject`, once per card. Without `gateway.owner`
the link is off: `gateway start` says so in its report and writes one structured log line, and a
gated run stays parked until it is answered from the REPL or the TUI.

### Reactions decide the card too

On Slack, Discord and Telegram a reaction on the delivered card is a decision: thumbs up (Slack
`+1` or `thumbsup`, unicode U+1F44D) or a check mark (`white_check_mark`, `heavy_check_mark`,
U+2705) approves; thumbs down (`-1`, `thumbsdown`, U+1F44E) or a cross mark (`x`, U+274C) denies.
Skin-tone and variation-selector suffixes are stripped; any other emoji is ignored. The adapters
surface these as `InboundReaction { platform, channelId, messageId, emoji, senderId, scope }`
through `onReaction` (Slack `reaction_added` over Socket Mode or the Events API; Discord
`MESSAGE_REACTION_ADD`, which needs the `GUILD_MESSAGE_REACTIONS` and `DIRECT_MESSAGE_REACTIONS`
intents the adapter now identifies with; Telegram `message_reaction`, which only arrives when
`allowed_updates` names it, as the adapter's `getUpdates` call does). A reaction carries no
approval id or nonce: `ApprovalBridge.resolveReaction` finds the pending row by the card's
delivery record (`deliveredTo` platform, channel and message id: `sendApproval` puts the approval id
on the queued row's metadata, and the queue's `onSent` hook calls `recordDelivery` with the platform's
receipt once the row is actually sent, from whichever process drains it)
and then resolves it through the same path as a button press, so the pending, nonce and
admin-pairing checks are identical. A second reaction on a decided card, a reaction from a
sender who is not a paired admin, or a reaction on a message that is not a delivered card
changes nothing.

### Questions from a seat (`ask_human`)

The `human` toolset gives every seat `ask_human {question, context?, options?}`. The step parks on
the same gate a tool approval uses, but the card is a question, not a yes/no: no buttons, the
question with its context and numbered options, and a line asking for a reply. Your next free-text
message in that chat is the answer. `ApprovalBridge.answerQuestion` matches it to the pending
question row by where the card was delivered (platform and channel), requires the sender to be a
paired admin there, stores the text as the row's `answer`, and resolves the row; the link then
resumes the run through `orchestrator.answer(runId, stepId, text)` and the seat's next turn sees
your text as the tool's result, verbatim. A reply from a sender who is not a paired admin, or in
another chat, changes nothing and goes to the agent as an ordinary message. `GatewayManager.
handleInbound` tries the question path before the agent handler sees the text, so an answer is
never mistaken for a new objective. In the REPL the same gate is a blocking prompt that reads one
line; a delegated child that calls `ask_human` gets `blocked` with a one-line reason instead of
parking, because the parent's tool loop cannot wait for you mid-call. Nothing answers on your
behalf: a step released without an answer gets a `failed` tool result that says so.

## Push alerts

With `gateway.owner` set, `gateway start` also pushes three kinds of plain-text alert to the owner
through `packages/trent-core/src/gateway/alerts.ts`, a bus hook the headless runtime composes onto
the same hook as the improve loop, telemetry and the approval link (`HeadlessRuntimeDeps.alerts`):

- A run that fails: one message per run, `Run <id> failed: <reason>`, where the reason is the
  `detail` the `run_failed` event carries, never a substitute.
- A gate nobody answered: `run_awaiting_approval` / `step_awaiting_approval` arms one timer per
  run and step; a `step_approved` or the run ending disarms it. If it fires, one reminder names the
  run, the step and the wait. The wait is `gateway.alerts.approval_wait_minutes` (default 30):

  ```yaml
  gateway:
    owner: { platform: telegram, channelId: "555" }
    alerts:
      approval_wait_minutes: 30
  ```

- A budget threshold: when a `budget` port is injected (`{ spentCents, limitCents, thresholds }`,
  the percentages from `budget.alert_thresholds`), each `step_end` with a cost and each `run_done`
  checks spent over limit and sends one message per threshold crossed, once per process. Two
  thresholds crossed by one step send two messages. `gateway start` does not inject a budget yet:
  the ledger lives in the REPL, and the port is the seam for handing it over.

Without `gateway.owner` the hook is inert: it writes one structured log line
(`gateway.alerts.disabled`) and never sends. A delivery failure is logged
(`gateway.alerts.send_failed`) and never thrown into the run.

## Threads are sessions

A chat thread is one session. `gateway.json` carries a `conversations` map from
`platform:chatId:threadId` (`root` when the platform has no thread) to a session id in the
profile's sessions directory, the same store `trent sessions` and the TUI read. The agent handler
(`apps/cli/src/gateway/agent-handler.ts`) resolves that mapping before every run: the first
message on a thread creates the session and records it, every later message resumes it, and each
turn appends the user's text and the run's reply to that session's transcript. A different thread
of the same chat is a different session. The mapping is a row like any other in the store, so it
survives a restart and a second process over the same profile. A message whose text is exactly
`/new` forgets the mapping for that thread and replies with nothing; the next message starts a
fresh session there.

## Double texting

A second message on a chat whose turn is still running used to start a second turn beside the
first. `packages/trent-core/src/gateway/ConversationQueue.ts` now serialises turns per
conversation, keyed by platform, chat and thread (a thread is its own conversation; different
chats never wait on each other), and `GatewayManager.handleInbound` routes every message that
passes the pairing gate through it. What the second message does is `gateway.double_text_policy`:

| Policy | While a turn is running, the next message... |
|---|---|
| `enqueue` (default) | waits, and runs as the next turn once the first settles |
| `interrupt` | aborts the running turn's `AbortSignal` (the agent handler receives it as its third argument) and runs once the old turn has settled |
| `reject` | is refused: the chat gets one status line saying a run is in progress, and the model never sees it |

A message whose text is exactly `/stop` aborts the running turn under every policy and starts no
turn of its own. The REPL applies the same three modes from `repl.double_text_policy`.

## Not yet implemented

- A published run against every live platform. The live tests exist but skip without credentials;
  only the wire tests run in CI.
- A `gateway` check in `trent doctor` that probes a configured platform end to end.
