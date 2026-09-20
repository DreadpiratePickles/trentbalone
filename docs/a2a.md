# A2A and ACP: talking to Trent from another agent or an editor

Trent exposes two protocols that other software already speaks, so nothing on the other side has
to learn a Trent-specific payload.

| Protocol | Command | Transport |
|---|---|---|
| [A2A](https://a2a-protocol.org/latest/specification/) | `trent a2a serve`, `trent a2a card` | JSON-RPC 2.0 over HTTP, streaming over Server-Sent Events |
| [ACP](https://agentclientprotocol.com/) | `trent acp` | newline-delimited JSON-RPC 2.0 over the process's stdin and stdout |

Both run one **real orchestration run** per request. Neither composes an answer of its own: what
comes back is the run's own output, and a server started without an agent runtime refuses instead
of inventing a result.

---

## A2A — Agent-to-Agent

```
trent a2a serve --port 7895
```

### Discovery

```
GET http://127.0.0.1:7895/.well-known/agent-card.json
```

The card is generated from the running process, not from a file: the `url` is the endpoint that
server is listening on, and there is one `skill` per seat, taken from the seat roster with the
seat's own name and description. `/.well-known/agent.json` answers the same card, for a client
pinned to the path used before A2A 0.3. The card carries both dialects' discovery fields, because
the root answers both: `protocolVersion: "0.3.0"`, `url` and `preferredTransport` for a 0.3.0
client, and `supportedInterfaces: [{url, protocolBinding: "JSONRPC", protocolVersion: "1.0"}]`
for a v1.0 client (which reads that first).

### Tags are toolsets

Each skill's `tags` are the seat's Trent toolsets, read from its capability record
(`packages/trent-core/src/fleet/seat-capabilities.ts`): the engineer advertises `terminal`, the
finance seat does not. They are the names a peer's operator can ask for: Hermes's
`a2a_orchestrate(capability, message)` matches `capability` against the `capabilities` list the
operator writes under `a2a_agents.<peer>` in its own `config.yaml`, never against the card
(verified from `plugins/platforms/a2a/tools.py` in Hermes v0.21.3,
`docs/sessions/2026-09-20-hermes-a2a-discovery-proof.md`), so the tags are what that operator
copies into that list; a category label or a model policy was nothing anyone could ask for.
Hermes's `a2a_discover` reads each skill's `name`, `id` and `description` and ignores `tags`.
`trent a2a card engineer` shows the tags for one seat.

### Interop status with Hermes (v0.21.3)

Both directions of the handshake now work, proven live with no model call
(`docs/sessions/2026-09-20-a2a-v1-wire.md`; discovery first proven in
`docs/sessions/2026-09-20-hermes-a2a-discovery-proof.md`):

- **Discovery.** Hermes's `a2a_discover` reads the card's `supportedInterfaces` and reports
  `Protocol: JSONRPC v1.0` (it used to warn `v0.3.0 (pre-1.0 card)`), then posts to that
  interface's `url`, which is the same server root.
- **Calls.** Hermes's `a2a_call` speaks A2A **v1.0** on the wire: method `SendMessage`, a message
  with `role: "ROLE_USER"` and parts `{text, mediaType}` with no `kind`, an `A2A-Version: 1.0`
  header, and it continues an exchange by `contextId` only, never sending a `taskId`. Trent now
  answers that request with the v1.0 `SendMessageResponse` (`{"task": ...}`), states spelled
  `TASK_STATE_*`, roles `ROLE_*`, parts without `kind`, and the `A2A-Version: 1.0` header. Hermes
  reads the first text artifact as the reply and keys its "the peer needs more input" hint on the
  literal `TASK_STATE_INPUT_REQUIRED`, which is why the answer is in v1.0 spelling rather than 0.3.
- **The dialect is the method name.** `SendMessage`, `SendStreamingMessage`, `GetTask` and
  `CancelTask` are translated at the JSON-RPC edge (`packages/trent-core/src/a2a/v1.ts`) onto the
  same task lifecycle the 0.3.0 methods use; `ListTasks` and `SubscribeToTask` answer `-32004`,
  the push-config methods `-32003`. A 0.3.0 request gets exactly the response it got before:
  `message/send` with v1.0 parts is still `-32005`, and no 0.3.0 answer carries the version header.
- **Known gap.** Hermes answers an `input-required` task by calling `a2a_call` again with the same
  `context_id` and no `taskId`, so that second message starts a NEW task in the same context rather
  than continuing the parked one; the gate's question is therefore not answerable from Hermes yet.
  A v1.0 client that names `taskId` continues the task as the specification describes.

`trent a2a card` prints that exact object; `trent a2a card engineer` prints it with `skills`
narrowed to one seat. `--endpoint <url>` sets the advertised `url` when Trent sits behind a proxy.

### Methods

JSON-RPC 2.0, POSTed to the card's `url` (the server root).

| Method (0.3.0) | v1.0 name | Behaviour |
|---|---|---|
| `message/send` | `SendMessage` | Creates a task (or continues the one named by `message.taskId`), runs it, and returns the terminal `Task` (v1.0: wrapped as `{"task": ...}`). The run's summary is the task's artifact, as text `Part`s. |
| `message/stream` | `SendStreamingMessage` | The same run as `text/event-stream`. The first frame is the `Task`; then a `status-update` per step of real progress, an `artifact-update` carrying the result, and a final `status-update` with `final: true` (v1.0: `{task}`, `{statusUpdate}`, `{artifactUpdate}` frames with no `kind` or `final`; the stream closing is the terminal signal). |
| `tasks/get` | `GetTask` | The stored task. `historyLength` trims the message history. |
| `tasks/cancel` | `CancelTask` | Aborts the run through its own `AbortSignal` and settles the task `canceled`. |

The two columns are one method surface: a request in either dialect reaches the same task, and a
task created by `SendMessage` can be read with `tasks/get` and vice versa. A v1.0-named request is
answered in v1.0 shapes (`TASK_STATE_*`, `ROLE_*`, parts discriminated by `{text}` with no `kind`)
under an `A2A-Version: 1.0` response header; a 0.3.0-named request is answered exactly as before.

States are the specification's `TaskState`: `submitted` -> `working` -> `completed`, `failed`,
`canceled`, or `input-required` (v1.0: `TASK_STATE_SUBMITTED` and so on). A run that parks on an approval gate (`ask_human`, `clarify`)
settles `input-required` and carries the gate's **own question** as the `status.message`; answer it
with a second `message/send` naming the same `taskId`.

### Errors

| Code | Meaning |
|---|---|
| `-32001` | `TaskNotFoundError` — no such task id here |
| `-32002` | `TaskNotCancelableError` — the task already reached a terminal state |
| `-32003` | `PushNotificationNotSupportedError` — Trent sends no webhooks |
| `-32004` | `UnsupportedOperationError` — `tasks/resubscribe`, the extended card |
| `-32005` | `ContentTypeNotSupportedError` — a non-text `Part` |
| `-32010` | Trent's own code, in the range the specification reserves for exactly this: the process was started with no agent runtime, so no task can run |
| `-32600`, `-32601`, `-32602`, `-32700` | JSON-RPC's own codes, with their usual meanings |

### Authentication

Set `TRENT_A2A_TOKEN` in the profile secrets file and every JSON-RPC request must carry
`Authorization: Bearer <token>`; anything else gets HTTP 401. The card then declares that
requirement in `security`. **With no token configured the card carries no `security` at all**,
because the server checks none — the card never advertises a check that does not happen. The
listener binds `127.0.0.1` in both cases.

### What is not implemented

- **Push notifications.** `capabilities.pushNotifications` is `false` and the four
  `tasks/pushNotificationConfig/*` methods answer `-32003`. Poll `tasks/get`, or use
  `message/stream`.
- **`tasks/resubscribe`** (v1.0 `SubscribeToTask`) and v1.0 **`ListTasks`**. A dropped stream is
  not re-attachable and tasks are not listed; the task survives, so read it with `tasks/get`.
- **Non-text `Part`s.** `defaultInputModes` and `defaultOutputModes` are `text/plain` only, and a
  file or data part is refused with `-32005`. The runtime port takes a text objective.
- **The authenticated extended card.** One card, at the well-known URI.
- **`stateTransitionHistory`.** Declared `false`: `Task.history` is the message history the
  specification defines, not the list of states.
- **Card signatures (JWS).** The card is unsigned. The separate HMAC-signed card on
  `GET /a2a/card/:id` predates the specification and is deprecated with the route below.

### The deprecated route

`POST /a2a/tasks` with Trent's own `{taskId, originAgent, targetAgent, taskType, parameters}`
payload — the shape Trent served before it spoke the specification — still works for **one
release**. Every response to it carries `Deprecation: true` and a `Link` header pointing at the
Agent Card. It is a translation layer over the same task lifecycle
(`packages/trent-core/src/a2a/legacy.ts`); when it goes, nothing else changes.

---

## ACP — editors

```
trent acp
```

`trent acp` with no flags **is** the protocol: it reads JSON-RPC from stdin and writes it to
stdout, one object per line, and runs until the editor closes the pipe. Nothing else is ever
written to stdout.

```jsonc
// VS Code (ACP Client), Zed `agent_servers`, and anything else that spawns an ACP agent:
{ "command": "trent", "args": ["acp"] }
```

| Method | Behaviour |
|---|---|
| `initialize` | Answers `protocolVersion: 1` with Trent's capabilities and `authMethods: []` — Trent authenticates to model providers from its own profile, so the editor has nothing to log in with. |
| `session/new` | Takes an absolute `cwd`; returns a `sessionId`. A relative `cwd` is `-32602`. |
| `session/prompt` | One real run. Every step's output is streamed as a `session/update` notification (`agent_message_chunk`), the run's summary is the last chunk, and the turn ends `{"stopReason": "end_turn"}`. |
| `session/cancel` | A notification. Aborts the run through its `AbortSignal`; the pending prompt then returns `{"stopReason": "cancelled"}`. |

A run that parks on an approval gate sends the gate's question as an agent message chunk and ends
the turn: this connection has no permission channel, so the question reaches you as text rather
than as a modal. A failed run is a JSON-RPC error carrying the run's own reason.

Not implemented: `session/load` (`loadSession` is `false`), image, audio and embedded-context
prompt blocks, `session/request_permission`, and the client-side `fs/*` and `terminal/*` methods —
Trent uses its own sandboxed tools rather than asking the editor to act for it.

### The HTTP form

```
trent acp --http --port 7890
```

The pre-protocol server: JSON-RPC over HTTP on a port, with `initialize`, `fleet/status`,
`file/read` and `agent/chat`. No editor speaks it; it is kept because existing integrations and
tests use it. New work should use the stdio form.
