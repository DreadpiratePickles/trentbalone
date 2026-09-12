# Milestone 7 — Width (task-level)

Only after one surface works end to end. This is where the previous effort started, and why it produced
eight subsystems that all looked finished and none of which worked.

---

## 7.1 — Messaging gateway, real transports
The previous adapters were seven classes whose every method was an empty body, and their test asserted
only that eight keys existed in a map.
- Start with **Telegram** and **Slack**; the rest follow the same shape.
- **RED test per platform, and it must involve a real round trip:** send a message to a test bot,
  receive it, route it to an agent, and assert the agent's real reply comes back. Where a live account
  is unavailable, run against the platform's official test/sandbox server and say so explicitly —
  do not substitute a mock and call it done.
- **Approvals over chat are the point.** Telegram inline keyboard, Slack interactive blocks, email
  reply parsing. And per the 2026 governance research: **a confirmation prompt inside the agent is not
  authorization.** The chat button is a view; enforcement stays server-side against a real approval row.
- Per-agent routing, a message queue, and health monitoring per platform, with a circuit breaker that
  pauses a flapping platform rather than retrying forever.
- Default-deny: an unknown sender gets nothing until paired. Hermes uses DM pairing codes with a
  one-hour expiry; match that.

## 7.2 — Egress proxy with real TLS interception
The previous one was a plain HTTP forwarder with no CONNECT handler that forwarded unauthenticated
requests to any host — an open relay on localhost.
- Real CONNECT-based interception, a locally generated CA, and credential injection at the boundary so
  the sandbox holds only opaque tokens.
- **On by default**, which is a deliberate advantage: Hermes ships this Docker-only and off.
- **RED tests:** an unauthenticated request is REFUSED, not forwarded; a request to a host outside
  `intercept_domains` is refused; the real key never appears in the container's environment (grep the
  container env and assert zero matches); a revoked token stops working immediately.
- Tokens must be ephemeral and durable across a restart, which means the token store is the SQLite
  store, not a `Map`.

## 7.3 — Docker backend with a real lifecycle
Current implementation shells out `docker run --rm` per command with the command string-interpolated
into a shell — a command-injection vector — and no lifecycle, no volumes, no network isolation.
- Real create/start/exec/stop/remove, network isolation flags, volume mounts, and the egress CA
  injected into the container.
- **Use an argument array, never string interpolation** (coding rule 6).
- **RED tests:** a container is actually removed after use; a command with shell metacharacters in the
  working directory does not escape; the container cannot reach a host outside the allowlist.
- **Note:** the Docker daemon is not running on this machine. These tests are `skipIf(!dockerAvailable)`
  and must be marked `untested-on-this-platform` in the verification report, never PASS, until CI runs
  them.

## 7.4 — SSH backend
Currently returns the literal `"[SSH Mock Backend: executed on ...]"` with a hardcoded 42 ms duration.
- Real ssh2 connection, real command execution, real SFTP.
- **RED test:** execute against a local sshd or a container and assert the returned stdout is the real
  command output, not a template string.

## 7.5 — Voice
Currently spawns `python3 -c 'print("whisper_ready_base")'` and returns
`"Transcribed N bytes of audio"`.
- Real faster-whisper sidecar, real audio capture, push-to-talk on Ctrl+B, offline.
- **RED test:** transcribe a fixture WAV of known content and assert the text matches.
- If the Python dependency conflicts with the zero-dependency binary goal, say so and make voice an
  opt-in extra that the doctor reports as not installed — do not pretend it ships.

## 7.6 — ACP over stdio
The current server is HTTP JSON-RPC on a port, but real editor integration is **JSON-RPC over stdio**,
so no editor can attach today. Add the stdio transport, `file/write` alongside `file/read`, and confine
file access to the workspace root — the current `file/read` will read any absolute path.

## 7.7 — Skills hub
`browse`/`search` currently operate on a six-item hard-coded array and `install` writes the catalog's
own sample string to disk. Wire it to a real source, keep the existing security scanner (which is real
and worth keeping), and add progressive disclosure so a skill costs a description until it is needed.

## Done when
Each subsystem does the thing its name claims, proven by a test that would fail against the previous
implementation.
