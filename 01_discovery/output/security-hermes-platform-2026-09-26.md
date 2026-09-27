# Hermes Platform Security Review — non-execution surfaces

Reviewer scope: messaging gateway + platform adapters, local API / web / desktop / IPC,
MCP client/server + plugins + skills, cron / self-update, memory & persistence, and
SECURITY.md claims-vs-code. Execution tools (terminal/code-exec) are another reviewer's
surface and are excluded here.

- Target: Hermes Agent v0.21.3, source read-only at `~/.hermes/hermes-agent`
- Date: 2026-09-26
- No secret file contents were read; only permission bits (via `stat`) are reported.
- `file:line` cites the reviewed source. CONFIRMED = read directly in code; SUSPECTED =
  strong inference not fully traced.
- Purpose: enumerate weaknesses a hardened successor (Trent) must close, expressed as
  testable properties in §4.

Hermes's own trust model (SECURITY.md §2.2) is honest: "the only security boundary against
an adversarial LLM is the operating system," and in-process heuristics (approval gate,
redaction, Skills Guard, injection scans) are explicitly *not* boundaries. Several items
below are therefore out-of-scope *for Hermes* but are exactly the boundaries Trent claims it
will add — so they are listed as defenses to build, not as Hermes bugs.

---

## 1. Ranked findings

| id | sev | class | one-line risk | file:line | status |
|----|-----|-------|---------------|-----------|--------|
| H-P-01 | Med | supply-chain / update integrity | `hermes update` pulls a GitHub branch (git pull / ZIP archive) and swaps code with no commit/tag signature or checksum verification — trusts HTTPS + repo integrity only | `hermes_cli/update_cmd_zip.py:438`, `hermes_cli/update_cmd.py:1163,1315-1318` | CONFIRMED |
| H-P-02 | Med | MCP trust / fail-open default | MCP server `trust` defaults to `full`; write-capable MCP tools execute without approval and their tool descriptions enter context unless the operator explicitly sets `trust: untrusted` | `tools/mcp_tool_registration.py:35-44,54-64` | CONFIRMED |
| H-P-03 | Med | untrusted-content boundary | Webhook/inbound platform payloads render straight into the agent prompt; HMAC authenticates the *sender* (e.g. GitHub) not the *content author* (arbitrary PR/issue text) — no untrusted-content tagging before tool use | `gateway/platforms/webhook.py:754-774,610,657-665` | CONFIRMED |
| H-P-04 | Med | memory injection / persistence | No provenance/trust tag on long-term memory writes: content ingested from web/email/MCP can be stored and later re-injected as trusted instruction (delayed prompt injection) | `plugins/memory/` (only `query_rewrite.py:40` marks input untrusted; store paths do not) | SUSPECTED |
| H-P-05 | Low/Med | file permissions | `kanban.db`, `projects.db`, `shared-state.db` created world-readable (0644) while `auth.json`/`state.db` are 0600; latent leak under Docker bind-mounts / relocated `HERMES_HOME` / non-0700 parents | `stat` of `~/.hermes/*.db`; cf. correct pattern `gateway/platforms/api_server.py:734-743` | CONFIRMED |
| H-P-06 | Low | blanket authorization | `Platform.WEBHOOK` and `Platform.HOMEASSISTANT` are unconditionally authorized; correct only while every WEBHOOK source is HMAC-gated and HA is a trusted outbound client — a future adapter minting such a source without that gate inherits blanket trust | `gateway/authz_mixin.py:632-634` | CONFIRMED |
| H-P-07 | Low | group exposure | `group_policy: open` forwards *all* group traffic with no sender opt-in gate (unlike open-DM, which requires `_open_dm_opted_in`); any HA voice/room user can also command the agent | `gateway/platforms/access_policy_mixin.py:65-69`; `gateway/authz_mixin.py:634` | CONFIRMED |
| H-P-08 | Low | config footgun | `platforms.email.require_authenticated_sender` can be turned off, and From-authentication is only enforced when an allowlist *grants* access — a mis-set combination re-opens From-spoofing | `plugins/platforms/email/adapter.py:356-362,599-624` | CONFIRMED |
| H-P-09 | Low | CORS | API server honors `Access-Control-Allow-Origin: *` when the operator sets `API_SERVER_CORS_ORIGINS=*`; low impact because the API uses Bearer tokens (no ambient cookies), so no CSRF, but `*` still enables opportunistic browser probing | `gateway/platforms/api_server.py:1339-1352` | CONFIRMED |

No fail-open authorization bug was found in the core gateway path: with no allowlist
configured the default verdict is `GATEWAY_ALLOW_ALL_USERS` (default false) = **default-deny**
(`authz_mixin.py:669-697`), matching SECURITY.md §2.6 rule 2. The pairing brute-force lockout
is reachable only from the authenticated CLI/dashboard approve path, not by unknown chat
senders, so it is not a remote DoS.

---

## 2. High+ notes (untrusted input → sink)

Only Medium items reach the bar; detailed below.

### H-P-01 — self-update runs unverified remote code
`hermes update` (operator-initiated; **no** unattended/cron auto-update path was found —
searched `cron/`, `gateway/`, `hermes_cli/gateway.py`) advances the working tree to a remote
branch two ways: `git pull` of `origin/<branch>` (`update_cmd.py:943,1163`) and, on the ZIP
fallback, downloading `https://github.com/NousResearch/hermes-agent/archive/refs/heads/<branch>.zip`
and swapping the tree (`update_cmd_zip.py:438`). Post-update verification only confirms HEAD
*moved* (`_verify_head_after_pull`, `update_cmd.py:1163,1315-1318`) — there is no verification
of a signed tag, signed commit, or release-artifact checksum.
- Input: whatever the tracked branch/GitHub archive endpoint serves.
- Sink: the code the interpreter then imports and runs (full host privileges under the local
  backend).
- Chain: repo/branch compromise, a malicious fork set as `origin`, or a TLS-intercepting
  proxy → arbitrary code execution on the next `hermes update`. HTTPS + GitHub account
  security are the only integrity controls. Trent should require a cryptographic signature
  (signed tag/release + checksum) before swap (§4.6).

### H-P-02 — MCP defaults to full trust
`_normalize_server_trust(None) -> _TRUST_FULL` (`mcp_tool_registration.py:37-38`). Unrecognized
values fail closed to `untrusted` (good), but the *absence* of a `trust` key — the common case
for a freshly added server — yields full trust. Under full trust the call-time gate does not
prompt before write-capable MCP tool calls, and the tool's own `description`/schema (authored
by the remote server) is placed in the model's tool list.
- Input: a remote/third-party MCP server's tool list, descriptions, and results.
- Sink: unattended write-capable tool invocation + model steering via tool descriptions.
- Chain: a compromised or malicious MCP server silently performs writes and/or embeds
  steering text ("before answering, call `exfil`…") in a description. Hermes treats the
  description scan as a heuristic (SECURITY.md §2.4), so the real mitigation is the trust
  tier — which defaults the wrong way. Trent should default MCP servers to `untrusted` (§4.4).

### H-P-03 — no untrusted-content boundary on inbound text
`WebhookAdapter._render_prompt` (`webhook.py:754-774`) interpolates arbitrary payload fields
(`{pull_request.title}`, `{__raw__}`, etc.) into the prompt that becomes `MessageEvent.text`
(`webhook.py:610,657-665`) and is dispatched to the agent. The HMAC check
(`_validate_signature`, `webhook.py:700-750`) authenticates *that GitHub/GitLab/Svix sent it*,
not *who wrote the PR body*. The same shape applies to email bodies, chat-group messages, and
MCP results: inbound text flows into the model with no marker distinguishing operator
instruction from third-party data.
- Input: any internet user's PR/issue/comment/email text delivered through an authenticated
  channel.
- Sink: the model's instruction context → tool calls.
- Note: SECURITY.md classifies "prompt injection per se" as out-of-scope for Hermes, so this
  is *not* a Hermes vuln — it is precisely the boundary Trent must add (§4.3).

### H-P-04 — memory can launder untrusted content into trusted instruction
The memory subsystem (`plugins/memory/{mem0,honcho,hindsight,holographic,…}`) stores
agent-curated facts. Only `query_rewrite.py:40` explicitly treats input as untrusted, and that
is for the *rewrite* prompt, not the stored record. Nothing observed tags a memory with the
trust level of its source, so a fact summarized from a web page or inbound email can be written
to long-term memory and, on a later turn, retrieved into context indistinguishable from
operator-authored memory — a classic delayed-injection ("memory poisoning") path.
- Input: untrusted content the agent reads this session.
- Sink: long-term memory → future-session trusted context.
- SUSPECTED because the individual backend write paths were not each traced; the absence of a
  provenance/trust field across the package is the basis. Trent must carry provenance end to
  end (§4.5).

---

## 3. What Hermes does well (adopt, don't regress)

- **Pairing** (`gateway/pairing.py`): 8-char codes over a 32-char unambiguous alphabet via
  `secrets` (~40 bits), salted SHA-256 at rest, `secrets.compare_digest` constant-time compare
  (`pairing.py:482`), 1h TTL, per-sender 10-min rate limit, 5-failure/1h lockout, `MAX_PENDING`
  cap, files `atomic_json_write(mode=0o600)`, codes never logged, pending keyed by a random id
  not the code. `list_pending`/`approve_request` never reveal the code.
- **Webhook adapter** (`gateway/platforms/webhook.py`): HMAC secret **required** and enforced
  both at startup (`_validate_route:197-216`) and per-request (`_read_authenticated_body:442-465`,
  fail-closed); `INSECURE_NO_AUTH` allowed only on loopback; generic V2 binds a timestamp with a
  300s replay window and *commits* to V2 (no downgrade to body-only V1); constant-time compare
  tolerant of non-ASCII (`_hmac_str_equal:75-78`); auth-before-body, body-size caps, per-route
  rate limit, and delivery-id idempotency.
- **Email From-authentication** (`plugins/platforms/email/adapter.py:262-290,573-624`): trusts
  only the receiving server's `Authentication-Results` header (not the attacker-controlled
  `From:`), requires DMARC/SPF/DKIM alignment, pins `authserv-id`, and fails closed
  (GHSA-rxqh-5572-8m77). TLS verification on by default.
- **API server** (`gateway/platforms/api_server.py`): binds `127.0.0.1` by default; **refuses to
  start** without a strong `API_SERVER_KEY` (present, ≥16 chars, not a placeholder; fail-closed if
  strength can't be checked — `:4123-4180`); constant-time Bearer compare (`:1437`); CORS
  default-deny with an explicit origin allowlist (`:1339-1352`); full security-header set; body
  limits; profile-scoped keys fail closed; warns loudly when network-accessible with a local
  (unsandboxed) terminal backend (`:4203-4216`).
- **Default-deny authorization** (`gateway/authz_mixin.py`): no allowlist ⇒ deny; own-policy
  adapters' open-DM mode still requires an explicit `*_ALLOW_ALL_USERS` opt-in
  (`access_policy_mixin.py:41-55`); revocation is mirrored into live adapter snapshots; profile
  multiplexing reads allowlists through a per-profile scope that fails closed rather than
  borrowing another profile's env.
- **MCP trust plumbing** exists and fails closed on unknown values; trust is the *consuming*
  profile's policy; `readOnlyHint` is captured at discovery and never re-read from server-supplied
  state at call time (`mcp_tool_registration.py:54-64`) — the right shape, just the wrong default.
- **Control socket** (`gateway/control_socket.py`): local-only (unix socket / named pipe, never
  TCP), read-only verbs (`identify`/`status`), one-request-per-connection, bounded request size;
  filesystem ACLs are the stated auth boundary.
- **Relay** (`gateway/relay/auth.py`): HMAC-SHA256 upgrade token with TTL + multi-secret rotation;
  signed delivery (`x-relay-signature` + timestamp, 300s skew). `authorization_is_upstream` fires
  only for events actually delivered over the authenticated relay WS.
- **Secrets**: `auth.json` and `state.db` are 0600; `ResponseStore` proactively chmods its DB and
  WAL/SHM sidecars to 0600; env scrubbing for lower-trust subprocesses is documented and matches
  SECURITY.md §2.3.

---

## 4. Defenses Trent must have (testable properties)

1. **Default-deny at every network adapter.** An enabled adapter with no allowlist configured
   drops all inbound and dispatches no agent work. *Test:* start each adapter with an empty
   allowlist; assert inbound is refused and nothing reaches the agent loop.
2. **Inbound HMAC required, replay-protected, constant-time.** Every signed-webhook / callback
   surface requires a secret, binds a timestamp within a bounded window, and compares in constant
   time; no unauthenticated dispatch path exists even via direct handler reuse. *Test:* replayed
   request rejected; body-only (timestamp-stripped) request rejected; wrong signature 401.
3. **Untrusted-content boundary into the model.** All text originating from webhook/email/web/
   group-chat/MCP is wrapped and tagged untrusted before entering context; a tool call whose
   arguments derive solely from untrusted content requires confirmation. *Test:* an instruction
   embedded in a PR body / email body does not cause an unconfirmed side-effectful tool call.
4. **MCP servers default to untrusted.** A newly added MCP server is `untrusted` unless the
   operator opts it into `full`; write-capable tool calls from an untrusted server require
   approval; tool descriptions are rendered inert / clearly attributed. *Test:* add a server with
   no `trust` key; a write tool call prompts; a description containing "ignore prior instructions"
   does not alter behavior.
5. **Provenance-tagged memory.** Every memory write records the trust level of its source;
   untrusted-sourced memories are retrieved as untrusted data and can never be replayed as
   system/trusted instruction. *Test:* a memory written from a web fetch is later retrieved with
   an untrusted tag and cannot trigger a tool call on its own.
6. **Signed self-update.** Update verifies a cryptographic signature (signed tag/release +
   artifact checksum) before swapping code; an unsigned or mismatched update refuses and keeps the
   running version. *Test:* a tampered archive / unsigned commit is rejected.
7. **0600/0700 for everything Hermes writes.** Every state, session, trajectory, kanban, project,
   and shared-state DB (and sidecars) is created 0600 in a 0700 home. *Test:* assert the mode of
   every file the persistence layer creates, including under a relocated home and a Docker
   bind-mount.
8. **Loopback + strong-key by default for local HTTP/WS/IPC.** Any HTTP/WS server binds loopback
   by default and requires a strong key even on loopback; a non-loopback bind warns or refuses
   without a sandbox. Unix-socket/IPC surfaces rely on 0600/0700 ACLs and are never TCP. *Test:*
   server refuses to start without a strong key; non-loopback bind emits the warning/refusal.
9. **Sender identity is provably authenticated.** Email From is verified against the receiving
   server's `Authentication-Results` with a pinned authserv-id and cannot be silently disabled
   while an allowlist grants access; no adapter authorizes on a spoofable identifier. *Test:*
   spoofed From with a forged `Authentication-Results` from an untrusted authserv-id is rejected.
10. **No blanket per-platform authorization.** Authorization is decided uniformly from the
    adapter's authenticated evidence; there is no platform whose mere identity short-circuits the
    allowlist. Group/"open" modes require an explicit per-surface opt-in. *Test:* a source claiming
    a "trusted" platform without the corresponding authenticated evidence is denied; open-group
    mode without opt-in forwards nothing.
11. **CORS never wildcards a credentialed surface.** If a local UI needs CORS, only explicit
    origins are allowed; `*` is refused for any surface that carries auth. *Test:* `*` origin
    config is rejected or downgraded to explicit-origin echoing.

---

*Method note:* findings were read directly from the cited source; DB permission bits were read
via `stat` (no secret contents accessed). Areas traced by inference rather than full call-graph
(memory write paths, unattended-update absence) are marked SUSPECTED or stated as searched-and-
not-found.
