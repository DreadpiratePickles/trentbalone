# Messaging gateway

The gateway lets an agent reach you on a messaging platform, and lets you answer an approval from
your phone. Twelve adapters are implemented against each platform's real protocol, and each is
tested against a local server speaking that protocol. Live tests against the real services are
gated behind `TRENT_TEST_LIVE=1` plus a per-platform credential and skip without one.

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
| matrix | `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN` | Client-server API v1.11: `/sync` long poll, `m.room.message` and `m.reaction` sends |
| mattermost | `MATTERMOST_URL`, `MATTERMOST_BOT_TOKEN` | API v4 REST plus the `/api/v4/websocket` event stream |
| line | `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` | Messaging API v2: reply and push; signed webhook at `/webhooks/line`; quick-reply buttons |
| ntfy | `NTFY_TOPIC` (optional `NTFY_URL`, `NTFY_TOKEN`, `NTFY_REPLY_TOPIC`) | Publish as JSON; the reply topic's `/json` stream; `http` action buttons |

Each adapter has a `*.wire.test.ts` (local HTTP, WebSocket or TCP server speaking the platform's
protocol); the first eight also have a `*.live.test.ts`. The registry test asserts exactly these
twelve platforms. Around the adapters sit a durable file-backed gateway store (queue, pairing and
approval rows), device pairing (default deny, random codes with a one-hour expiry, rate limited,
admin and regular tiers), a per-platform circuit breaker and health, and approvals that are checked
against the durable row so a forged or replayed callback is rejected.

## Matrix, Mattermost, LINE and ntfy

Four platforms with clean public APIs, added for gap 5 of
`01_discovery/output/harness-landscape-2026-09-26.md`. Each wire test drives the real
`GatewayManager` too: an unknown sender gets a pairing code and no run, a paired one is routed, and
an approval card is decided on the platform. Each keeps a cursor in `gateway.json` (`cursors`), so a
restart resumes where it stopped and never hands the agent the same message twice:

| Platform | Inbound | Cursor | Approval card | Reply in a thread |
|---|---|---|---|---|
| matrix | `/sync` long poll; with no stored token the first sync is history and is skipped; an invite is joined | `matrix.since`, the last `next_batch`, stored before its batch is dispatched | text with the `APPROVE <id> <nonce>` line; a reaction decides | `m.thread` relation |
| mattermost | the WebSocket, authenticated with an `authentication_challenge` frame | `mattermost.last`, `<create_at>:<post id>`; an older post, or that one again, is dropped | text with the reply line; a reaction (`+1`, `white_check_mark`, `-1`, `x`) decides | `root_id` |
| line | the webhook, `POST /webhooks/line` | `line.seen`, the last 512 `webhookEventId`s; a redelivery is dropped | quick-reply postback buttons | none; the event's reply token while fresh (single use, 50 s here), else a push with `X-Line-Retry-Key` |
| ntfy | the reply topic's `/<topic>/json` stream | `ntfy.since`, the last message id, sent back as `since=` | `http` action buttons that publish the action id to the reply topic | none |

- **LINE** checks `X-Line-Signature` (base64 HMAC-SHA256 of the raw body with the channel secret)
  before it parses anything: a bad or missing signature is 401 and nothing is routed or sent. The
  webhook rides the same `WebhookServer` path as WhatsApp's. `gateway start` opens that listener
  when a webhook-only platform starts (LINE, WhatsApp, Home Assistant, Slack without
  `SLACK_APP_TOKEN`, Telegram with `TELEGRAM_WEBHOOK_URL`) or `gateway.webhooks` has a route, on
  `gateway.webhooks.host` and `port` (default `127.0.0.1:8644`, loopback: put a tunnel or a reverse
  proxy in front, [webhooks.md](webhooks.md)). Set the webhook URL in the LINE Developers Console
  to `https://<your host>/webhooks/line`.
- **ntfy has no sender identity.** Whoever can publish to the reply topic is the sender, so the
  reply topic is what gets paired (`trent gateway pair ntfy <code>`), and its name, or an access
  list on your own server, is the credential. Use a long random topic on ntfy.sh. The action buttons
  carry no `Authorization` header, because anyone who can read the topic can read a notification
  and the token must never ride inside one; tap-to-approve therefore needs a reply topic the phone
  can publish to without a token, and publishing the `trent:approve:<id>:<nonce>` line from the app
  always works. Trent tags what it publishes `robot` and ignores that tag on the reply topic, so one
  topic can carry both ways.
- **Mattermost** interactive buttons are not used: Mattermost posts a button press to an
  integration URL unsigned, so anyone who can reach that URL could press as the admin.
- **Matrix** encrypted rooms are not read (one warning per room); invite the bot to an unencrypted
  room. `m.notice` messages (what bots send) and edits are ignored. A room with two joined members is
  a DM; larger rooms are groups, where pairing is granted by the operator, never offered.

Sources for every endpoint, cited in each adapter's header: spec.matrix.org (client-server API
v1.11), api.mattermost.com, developers.line.biz (Messaging API reference), docs.ntfy.sh.

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

`gateway setup <platform>` writes the names that platform's adapter reads (its registry entry,
`packages/trent-core/src/gateway/registry.ts`) into the profile's `.env`: `--token <token>` goes to
the platform's token name (`TELEGRAM_BOT_TOKEN`, `MATRIX_ACCESS_TOKEN`, `LINE_CHANNEL_ACCESS_TOKEN`,
`NTFY_TOKEN`, ...) and `--set NAME=value` to any other name it reads, e.g.
`gateway setup matrix --token <token> --set MATRIX_HOMESERVER_URL=https://matrix.example.org`,
`gateway setup line --token <token> --set LINE_CHANNEL_SECRET=<secret>` or
`gateway setup ntfy --set NTFY_TOPIC=<topic>`; Signal has no token (`--set SIGNAL_NUMBER=<number>`).
A name the platform does not read is refused. The reply names what was written and any required
name still missing, never a value.

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
To keep it up across reboots, with the cron runner and the heartbeat, install it as one supervised launchd or systemd service: `trent service install` ([service.md](service.md)).

## Pairing a sender

Nobody reaches the agent until you pair them. An unknown sender's first direct message gets one
reply, which names no command:

    Trent does not know you yet.
    Pairing code: 7KQ2M9XD
    The owner can approve it; the code expires in one hour.

`gateway pairings` shows every live code with the sender id that holds it, and every paired sender:

    trent gateway pairings                          # paired senders; live codes and who holds them
    trent gateway pair telegram 7KQ2M9XD            # regular: their messages reach the agent
    trent gateway pair telegram 7KQ2M9XD --admin    # admin: their button, reaction or reply also decides approval cards
    trent gateway revoke telegram 555               # unpair; their next message gets a new code

All three write `<profile>/gateway.json` the way `trent approvals approve` does, so they work while
`gateway start` or the service daemon holds the profile, and the running gateway sees a pairing on
the sender's next message. Codes are eight characters from an alphabet without 0/O or 1/I, at most
three per sender per 24 hours. An unknown or expired code, an unknown platform, or a revoke of a
sender who is not paired exits 2. A sender in a group is never offered a code: pair them over DM
(`apps/cli/src/commands/__tests__/gateway-pair.test.ts`).

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
The card is plain text: `APPROVAL REQUIRED`, one line `<seat> wants to run <tool> on <target> for
<amount>` (the amount from integer cents, `$241.00`), and `Ref: <approval id>`. The call's arguments
stay on the row, never in the card. Only a sender paired with `--admin` can decide it
(`packages/trent-core/src/gateway/ApprovalBridge.test.ts`).

### Reactions decide the card too

On Slack, Discord, Telegram, Matrix and Mattermost a reaction on the delivered card is a decision:
thumbs up (Slack
`+1` or `thumbsup`, unicode U+1F44D) or a check mark (`white_check_mark`, `heavy_check_mark`,
U+2705) approves; thumbs down (`-1`, `thumbsdown`, U+1F44E) or a cross mark (`x`, U+274C) denies.
Skin-tone and variation-selector suffixes are stripped; any other emoji is ignored. The adapters
surface these as `InboundReaction { platform, channelId, messageId, emoji, senderId, scope }`
through `onReaction` (Slack `reaction_added` over Socket Mode or the Events API; Discord
`MESSAGE_REACTION_ADD`, which needs the `GUILD_MESSAGE_REACTIONS` and `DIRECT_MESSAGE_REACTIONS`
intents the adapter now identifies with; Telegram `message_reaction`, which only arrives when
`allowed_updates` names it, as the adapter's `getUpdates` call does; Matrix `m.reaction` with an
`m.annotation` relation from `/sync`; Mattermost `reaction_added` on its WebSocket, with Slack's
names). A reaction carries no
approval id or nonce: `ApprovalBridge.resolveReaction` finds the pending row by the card's
delivery record (`deliveredTo` platform, channel and message id: `sendApproval` puts the approval id
on the queued row's metadata, and the queue's `onSent` hook calls `recordDelivery` with the platform's
receipt once the row is actually sent, from whichever process drains it)
and then resolves it through the same path as a button press, so the pending, nonce and
admin-pairing checks are identical. A second reaction on a decided card, a reaction from a
sender who is not a paired admin, or a reaction on a message that is not a delivered card
changes nothing.
Pair yourself with `trent gateway pair <platform> <code> --admin` before you expect a reaction to count.

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

## Voice notes

A voice note (or an audio file) sent to Trent on Telegram, WhatsApp, Signal, Discord, Slack,
Matrix, Mattermost, LINE or ntfy is transcribed, and the run sees text:
`[voice note, <n>s] <transcript>`, with any caption on the next line. From there it is an ordinary
message, so a spoken reply can also answer an `ask_human` question.
`packages/trent-core/src/gateway/voice-notes.ts` does the work, called once from
`GatewayManager.handleInbound` **after** the pairing gate: an unpaired sender's audio is never
downloaded or transcribed, it gets the pairing code like any other message.

| Platform | What the adapter carries | Fetched with |
|---|---|---|
| telegram | `voice` and `audio` messages (duration and size declared) | `getFile`, then `/file/bot<token>/<file_path>` |
| whatsapp | `type: "audio"` messages | `GET /<media-id>`, then the returned URL on `lookaside.fbsbx.com`, with the bearer token |
| signal | attachments with an `audio/*` content type (a voice note has no text) | JSON-RPC `getAttachment` from signal-cli's store |
| discord | attachments with an `audio/*` content type (a voice message has `duration_secs`) | the attachment URL on `cdn.discordapp.com` / `media.discordapp.net`, no token |
| slack | shared files with an `audio/*` mimetype (`duration_ms`) | `url_private_download` on `files.slack.com`, with the bot token |
| matrix | `m.audio` messages (`info.duration` in ms, `info.size`) | `/_matrix/client/v1/media/download/<server>/<id>` on your homeserver, with the access token |
| mattermost | post files with an `audio/*` `mime_type` | `/api/v4/files/<id>` on your server, with the bot token |
| line | `audio` messages from LINE's own content provider (`duration` in ms) | `api-data.line.me/v2/bot/message/<id>/content`, with the channel token |
| ntfy | attachments with an `audio/*` type | the attachment URL, only on your ntfy server's own origin, with the token if one is set |

An adapter only declares the attachment and a lazy `open()`; it downloads nothing in its own
dispatch, which runs before pairing. A credential goes only to that platform's own file host (or
the adapter's configured base URL); a URL anywhere else is refused before any request is made. The
bytes land in `<profile>/inbox/<platform>/<message-id>.<ext>` (file 0600, directory 0700) and stay
there; the path rides on the message's attachment and in `metadata.voiceNotes`.

Transcription uses the media toolset's engines, resolved as `media_transcribe` resolves them
(`tools/media/transcribe.ts`, see [media.md](media.md)): whisper.cpp or faster-whisper, on the host
or in the `trent-sandbox-media` image. The hosted path is never used here, because it needs a
per-call approval and a run to bill, and an inbound note has neither yet. With no local engine the
sender gets one reply naming what to install (the doctor's hint) and nothing runs.

Refusals are one reply each, and the message does not run: a note longer than
`gateway.voice_notes.max_seconds` (default 300; checked on the declared length before download, else
on ffprobe's length after it), a download over `gateway.voice_notes.max_bytes` (default 20 MiB),
a failed download, a failed transcription, or a note with no speech. `gateway.voice_notes.enabled:
false` refuses voice notes (a caption still runs as text). Email, Teams and Home Assistant carry no
audio. Tests: one voice case in each of the nine `*.wire.test.ts` files, and
`gateway/voice-notes.test.ts` for the dispatch order and every refusal.

## Not yet implemented

- A published run against every live platform. The live tests exist but skip without credentials;
  only the wire tests run in CI.
- A `gateway` check in `trent doctor` that probes a configured platform end to end.
