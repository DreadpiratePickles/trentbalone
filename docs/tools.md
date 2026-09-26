# Tool disclosure, `todo`, `clarify` and `session_search`

Four things that are about how a seat uses its tools rather than about any one tool: a way to keep a
large catalog out of the prompt, a task list that outlives compaction, a way to ask five questions
in one interruption, and a way to read the profile's own past.

A tool's **description** is not fixed at the code either: a tool whose arguments the model keeps
getting wrong becomes a gated proposal to rewrite that one line, promoted by a human and applied
at registration over the shipped adapter (docs/improve.md, "Tools improve too"; `trent improve tools`).

Everything here is implemented in `packages/trent-core/src/tools/` and proved by
`tools/tool_search/disclosure.test.ts`, `tools/todo/todo.test.ts`, `tools/clarify/clarify.test.ts`,
`tools/session_search/session_search.test.ts` and `sessions/search.test.ts`.

## Progressive disclosure

Every registered tool used to be rendered into every seat's prompt in full. One MCP server with
forty tools therefore cost forty schemas on every turn of every seat, whether or not a connector was
ever touched. Disclosure replaces those schemas with three bridges.

**What is deferred**

- Every MCP, plugin and app-catalog tool, at any catalog size. Their number and their descriptions
  come from outside this repository, so neither is ours to bound.
- Everything outside the core adapters — `file_ops`, `human`, `memory`, `fleet_search`, `todo`,
  `clarify`, `session_search` — once the registered tool count passes `tools.disclosure_threshold`.

A deferred tool keeps its adapter registered and keeps working. Only its **name** leaves the seat's
advertised tool list and its **schema** leaves the prompt; the adapter's own name stays, and its
instruction block ends with a line saying how many of its tools are not listed.

**The three bridges**

| Tool | Arguments | What it does |
|---|---|---|
| `tool_search` | `query`, `limit` | Ranks every deferred tool over its name and description (TF-IDF, names weighted, `tools/tool_search/rank.ts`) and returns one line each. Read-only |
| `tool_describe` | `name` | Returns that tool's full schema: description and every argument |
| `tool_call` | `name`, `arguments` | Calls it |

**`tool_call` is not a bypass.** `buildTrentTools` wraps every adapter first — autonomy level,
hardline blocklist, `approvals.deny` globs, approval floors, policy rules, idempotency, user hooks —
and applies disclosure last, so the bridges hold *wrapped* adapters. A `tool_call` composes the same
`"<tool> <json>"` action a direct call composes and hands it to the same wrapped adapter, hitting
the same gates in the same order with the same idempotency key. `adaptersForSeat` narrows the bridge
to the seat's own adapters as well, so a seat whose manifest grants it no `terminal` cannot reach
`terminal` through `tool_call` either. A name nothing answers to returns a typed `unknown_tool`
record naming `tool_search`, never a guess.

**Configuration** — `tools.disclosure_threshold`, default 24:

```yaml
tools:
  disclosure_threshold: 24
```

Raising it buys direct schemas at the cost of prompt context on every turn. Lowering it buys context
at the cost of one extra round trip the first time a tool is needed. When there is nothing worth
deferring — no configured MCP server, no foreign tool names, a catalog under the threshold — the
bridges are not registered at all, and the adapter list is exactly what it was.

## `media`

The local clip pipeline, in its own page: docs/media.md. One row here so the toolset table is
complete:

| Toolset | Tools | Backend | Approval |
|---|---|---|---|
| `media` | `media_probe`, `media_transcribe`, `media_scenes`, `media_clip`, `media_thumbnail` | `trent-sandbox-media:1` when built, else the host's `ffmpeg`, `ffprobe`, `whisper-cli`, `scenedetect`, `python3` (an allowlist; argv only, never a shell string) | Only `media_transcribe` on the hosted path, which is off until `media.hosted_transcription` is set and then asks every time, because the audio leaves the machine |

## `business`

The small-business assistant's executors, in their own page: docs/business.md. One row here so
the toolset table is complete:

| Toolset | Tools | Backend | Approval |
|---|---|---|---|
| `business` | `customer_search`, `stripe_invoice_create`, `stripe_invoice_send`, `stripe_quote_create`, `stripe_payment_link_create`, `calendar_list`, `calendar_appointment_create`, `calendar_appointment_cancel`, `square_bookings_list`, `square_booking_create`, `square_booking_cancel`, `square_invoice_create`, `square_invoice_send`, `sms_send` | Stripe, Google Calendar, Square and Twilio over HTTPS through the egress proxy, with the token `trent connect <provider>` stored | Every write asks at every autonomy level (the class floor), bound to the exact recipient, amount with currency, date and time or message text it previewed; the three reads (`customer_search`, `calendar_list`, `square_bookings_list`) do not ask, and the two that return customer-authored text tag it untrusted |

## `social`

The social-media manager, in its own page: docs/social.md. One row here so the toolset table is
complete:

| Toolset | Tools | Backend | Approval |
|---|---|---|---|
| `social` | `social_platforms_list`, `social_post`, `social_reply`, `social_inbox_list`, `social_insights_read`, `social_schedule` | The app's live adapter for Facebook and Instagram (Meta Graph) and YouTube replies and insights, the AT Protocol for Bluesky, Buffer's GraphQL API for X, LinkedIn, TikTok, Threads and any other Buffer channel; tokens from `trent connect` | Every post, reply and queued post asks at every level and is bound to the exact text, platform, media URL and time; the inbox is returned `untrusted`, so a reply after reading it asks again; no DMs on any platform |

## `a2a`

Trent as an A2A client: the other direction of `trent a2a serve`, in its own section of
docs/a2a.md ("Calling other agents"). Off until `a2a.peers` names a peer. One row here so the
toolset table is complete:

| Toolset | Tools | Backend | Approval |
|---|---|---|---|
| `a2a` | `a2a_list`, `a2a_discover`, `a2a_send`, `a2a_history` | JSON-RPC to the peers named in `a2a.peers`, A2A v1.0 (`SendMessage`) or 0.3.0 (`message/send`) as each peer's Agent Card advertises, through the egress proxy; the bearer read by the name `token_env` gives from the profile secrets file | `a2a_send` asks at every autonomy level (the class floor), bound to the exact peer and message it previewed, and is keyed so a replay does not send twice; `a2a_list` and `a2a_history` read the profile and `a2a_discover` fetches a card, none of them asks; only a configured peer's origin is reachable; everything a peer wrote comes back `untrusted` |

## `todo`

The run's task list: `todo {"action":"add","items":[...]}`, `todo {"action":"update","id":"t1",
"status":"doing"}`, `todo {"action":"list"}`. Statuses are `todo`, `doing`, `done`, `blocked`, and
an unknown one is refused with the four named rather than coerced.

It is durable, which is the whole point. MAST's failure taxonomy puts step repetition and loss of
task state among the common multi-agent failures, and a seat with no written plan re-derives one
every turn from a transcript that compaction is actively shortening. The list is therefore kept
outside the transcript, at `<profile>/todos.json`, written the way a session transcript is written:
write-then-rename, mode 0600, in a 0700 directory. The orchestration run record was the other
candidate and it loses — under Node every durable layer the wrapper builds is an `EphemeralStore`
(AGENTS.md known defect 9), so a list kept there does not survive the process that wrote it.

Bounds: 100 items per run, 50 runs retained. `createTodoAdapter(...).items(runId)` is the getter a
surface renders from; no REPL or TUI rendering ships with this change.

## `clarify`

Up to five independent questions in one founder card:

```json
clarify {"questions":[{"id":"region","question":"Which region first?","choices":["EU","US"]},
                      {"id":"date","question":"What date do we announce?"}]}
```

A sixth is refused, naming the count it was given, and nothing is asked — the alternative is
silently dropping a question the seat believed it had asked.

There is no second parking mechanism. `clarify` rides `ask_human`'s path exactly:
`requiresApproval` answers true, the guardrail executor calls `dryRun`, the `needs_approval` record
carries `details: {kind: "questions", ...}`, the seat loop parks the run, and
`Orchestrator.answer(runId, stepId, text)` releases it. Every surface reads the card through the one
function they already read gates with (`questionFromEvent`), so the REPL, the gateway and one-shot
`trent run` — which exits 7 with the approval id — show it without knowing this tool exists.

The reply is split across the questions in three shapes, in order: lines keyed `"<id>: <answer>"`;
one line per question, in order; and anything else, which is handed back verbatim with a note.
Guessing which sentence answers which question is exactly the invention this tool exists to avoid,
and a release with no text is a failure that says so.

## `session_search`

`session_search {"query":"...", "session_id":"...", "after":"7d", "before":"...", "exclude_session_ids":[...], "limit":10}`
searches this profile's past transcripts and returns the session id, the message index, the
timestamp, the role and a snippet, best match first.
`trent sessions search <query> [--limit n] [--session id] [--after when] [--before when] [--exclude ids] [--json]`
is the same search from the command line.

Time windows (X5): `after` and `before` take an ISO date or a window counted back from now, `24h`,
`7d` or `2w` (hours, days, weeks); a message outside the window is filtered out before ranking, on
both backends, so it never appears. `exclude_session_ids` (`--exclude a,b` on the command line)
leaves whole sessions out, typically the one the seat is in. A bound that reads as neither a date
nor a window is refused by name (`failed` on the tool, exit code 2 on the command line) rather
than widening the search to everything. The tool and the command share one parser
(`sessions/search.ts`, `parseSearchInstant`), so `--after 7d` and `"after":"7d"` answer alike.

Two backends, one row shape:

- **FTS5** when this runtime has `node:sqlite` and that SQLite was built with it. The index is built
  per query, in memory, from records the caller already holds: transcripts live as JSON files, not
  rows, so there is no table to keep in step and nothing about them is written to a second file with
  its own permissions to get wrong. Ranking is bm25.
- **Lexical** otherwise: the same TF-IDF ranker `tool_search` uses, over message content, with a
  window around the first matching term as the snippet.

The backend used is reported in the result rather than assumed, and a query that matches nothing
returns no rows rather than the whole corpus.
