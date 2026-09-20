# 2026-09-20 — Hermes <-> Trent A2A discovery proof (no model, no spend)

Branch `feature/trent-fleet-v2`, HEAD 2bf5df2. Invariants held: no subagents; no commit, stash,
checkout or push; nothing under `~/.hermes` or the Hermes install modified; no `hermes tools
enable`, `hermes setup` or Hermes chat; no secret read (`gem.env`, `~/.hermes/auth.json`,
`~/.hermes/.env` untouched); `TRENT_QUEUE_FALLBACK=disabled` in every shell; no model call.

## Goal
Prove, live, that Hermes's own A2A client code (`a2a_discover` / `_fetch_card`) fetches and parses
the Agent Card that `trent a2a serve` publishes, and record every field it parsed, every field it
ignored, and every gap between the two implementations.

## Status log (appended during the session)

## Outcome (three lines)
1. **Discovery PASS.** Hermes v0.21.3's own client (`plugins/platforms/a2a/tools.py::_fetch_card` and
   `a2a_discover`), called directly from the Hermes venv python with no model, fetched Trent's card
   at `http://127.0.0.1:7899/.well-known/agent-card.json` and parsed name, url, capabilities and all
   nine skills; it rejected nothing and warned only `Protocol: v0.3.0 (pre-1.0 card)`.
2. **No card defect.** The one field Hermes prefers and Trent lacks, `supportedInterfaces`, is an
   A2A v1.0 field; Hermes falls back to the card's `url` and discovery completes. Adding it to a
   card that says `protocolVersion: 0.3.0` would advertise a version the endpoint does not speak,
   so it was NOT added (see "Why no code change").
3. **Calls FAIL at the RPC layer, proven with zero spend.** Hermes's `a2a_call` sends A2A v1.0
   (`SendMessage`, `ROLE_USER`, parts without `kind`); Trent's 0.3.0 server answers `-32601` /
   `-32005` before any task is created. That is a protocol-version gap in `rpc.ts`,
   `TaskLifecycle.ts` and `spec.ts`, out of this proof's scope and recorded as a follow-up.

## Environment
- Hermes: `Hermes Agent v0.21.3 (2026.9.14) · upstream 49eb7b5d`, install `~/.hermes/hermes-agent`
  (git), Python 3.11.15, venv `~/.hermes/hermes-agent/venv`. `hermes --version` exit 0.
- Hermes A2A source: `~/.hermes/hermes-agent/plugins/platforms/a2a/{tools.py,protocol.py,adapter.py,security.py}`.
  Card fetch is `tools._fetch_card(base_url, headers, timeout)` (GET `/.well-known/agent-card.json`,
  404 -> `/.well-known/agent.json`); the summariser is `tools.a2a_discover({"url": ...})`; the RPC
  endpoint choice is `tools._rpc_url` (`supportedInterfaces[].protocolBinding == "JSONRPC"` first,
  then the legacy top-level `url`, then the base). No `hermes a2a` CLI subcommand exists
  (`hermes --help | grep -i a2a` prints nothing), and Hermes has no card validator: the only
  no-model path is importing the module, which is what was done.
- Trent: run from source with `npx tsx apps/cli/src/index.ts` (the compiled `apps/cli/dist/index.js`
  is dated Sep 12 and predates the A2A spec transport, so it was not used). Profile isolated with
  `TRENT_HOME=<scratch>/trent-home` (fresh, no config, no token, so the card carries no `security`).
  Port 7899 (checked free with `lsof -nP -iTCP:7899 -sTCP:LISTEN`, exit 1).
- `HERMES_HOME=<scratch>/hermes-home` for every Hermes import, so nothing under `~/.hermes` was read
  for config or written. Importing the package scaffolds an empty home there (SOUL.md, cron/, ...),
  in the scratch directory only. `~/.hermes/a2a_audit.jsonl` and `~/.hermes/a2a_conversations/` do
  not exist after the run (`_send_task`, which writes them, was never called).

## Commands, in order, with exit codes
```
cd /Users/bobbymeher/Desktop/trent; export TRENT_QUEUE_FALLBACK=disabled
export TRENT_HOME=<scratch>/trent-home
npx tsx apps/cli/src/index.ts a2a serve --dry-run --port 7899 --json      # exit 0
lsof -nP -iTCP:7899 -sTCP:LISTEN                                             # exit 1 (free)
nohup npx tsx apps/cli/src/index.ts a2a serve --port 7899 --json &          # pid 4314; stdout:
#   {"server":"a2a","port":7899,"listening":true,"runner":true}
curl -sS -w 'HTTP %{http_code}' http://127.0.0.1:7899/.well-known/agent-card.json   # HTTP 200
curl -sS -w 'HTTP %{http_code}' http://127.0.0.1:7899/.well-known/agent.json        # HTTP 200
HERMES_HOME=<scratch>/hermes-home ~/.hermes/hermes-agent/venv/bin/python hermes_discover.py http://127.0.0.1:7899 <scratch>/hermes-parsed-card.json   # exit 0
HERMES_HOME=<scratch>/hermes-home ~/.hermes/hermes-agent/venv/bin/python hermes_wire_probe.py http://127.0.0.1:7899/                                 # exit 0
HERMES_HOME=<scratch>/hermes-home ~/.hermes/hermes-agent/venv/bin/python - <<EOF  # protocol.build_agent_card(...) offline, exit 0
npx tsc --noEmit --strict ... <scratch>/typecheck/hermes-card-vs-trent-spec.ts       # exit 2 (expected: TS2739)
kill -TERM 4314; lsof -nP -iTCP:7899 -sTCP:LISTEN                                    # exit 1 (released); pid gone
npx vitest run packages/trent-core/src/a2a                                          # exit 0, 4 files, 32 tests
(cd packages/trent-core && npx tsc -p tsconfig.json --noEmit)                        # exit 0
```
`hermes_discover.py` and `hermes_wire_probe.py` are reproduced in full under "Scripts" below.

## What Hermes parsed — `_fetch_card` return value, verbatim
Confirmed free of secrets before pasting: no token was configured, `security` is absent, and the
only "token" in the text is the `securitySchemes.bearerAuth.description` sentence.
```json
{
  "protocolVersion": "0.3.0",
  "name": "Trent Fleet",
  "description": "An autonomous cofounder fleet. One message is one orchestration run across the seats below, and the run's own output comes back as the task artifact.",
  "url": "http://127.0.0.1:7899/",
  "preferredTransport": "JSONRPC",
  "version": "1.0.0",
  "capabilities": {"streaming": true, "pushNotifications": false, "stateTransitionHistory": false},
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "securitySchemes": {"bearerAuth": {"type": "http", "scheme": "bearer", "description": "The token from the profile secrets file, presented as an Authorization header."}},
  "supportsAuthenticatedExtendedCard": false,
  "skills": [
    {"id": "ceo", "name": "CEO Agent", "description": "Prioritizes strategy, roadmap, risks, and operating cycle summaries.", "tags": ["browser", "business", "cron", "delegation", "file_ops", "human", "mcp", "media", "memory", "plugins", "skills", "vision", "web"], "inputModes": ["text/plain"], "outputModes": ["text/plain"]},
    {"id": "engineer", "name": "Lead Engineer", "description": "Plans code changes, GitHub work, tests, and technical architecture.", "tags": ["browser", "code", "cron", "delegation", "file_ops", "human", "mcp", "media", "memory", "plugins", "skills", "terminal", "vision", "web"], "inputModes": ["text/plain"], "outputModes": ["text/plain"]},
    {"id": "growth", "name": "Growth Hacker", "description": "Designs acquisition experiments, campaigns, and funnel improvements.", "tags": ["browser", "cron", "delegation", "file_ops", "human", "mcp", "media", "memory", "plugins", "skills", "social", "vision", "web"], "inputModes": ["text/plain"], "outputModes": ["text/plain"]},
    {"id": "content", "name": "Design & Content Lead", "description": "Creates design direction, landing copy, docs, and creative briefs.", "tags": ["browser", "cron", "delegation", "file_ops", "human", "mcp", "media", "memory", "plugins", "skills", "social", "vision", "web"], "inputModes": ["text/plain"], "outputModes": ["text/plain"]},
    {"id": "support", "name": "Support & Ops Responder", "description": "Drafts replies, mines customer feedback, and handles operational queues.", "tags": ["browser", "business", "cron", "delegation", "file_ops", "human", "mcp", "media", "memory", "plugins", "skills", "vision", "web"], "inputModes": ["text/plain"], "outputModes": ["text/plain"]},
    {"id": "analyst", "name": "Market & Data Analyst", "description": "Researches markets, competitors, and revenue metrics.", "tags": ["browser", "business", "code", "cron", "delegation", "file_ops", "human", "mcp", "media", "memory", "plugins", "skills", "terminal", "vision", "web"], "inputModes": ["text/plain"], "outputModes": ["text/plain"]},
    {"id": "finance", "name": "Finance & Treasury Lead", "description": "Tracks spend, margins, budget caps, and financial runways.", "tags": ["browser", "business", "cron", "delegation", "human", "mcp", "media", "memory", "plugins", "skills", "vision", "web"], "inputModes": ["text/plain"], "outputModes": ["text/plain"]},
    {"id": "escalation", "name": "Critic & Compliance Auditor", "description": "Critiques plans and audits risk before irreversible execution.", "tags": ["browser", "cron", "delegation", "human", "mcp", "media", "memory", "plugins", "skills", "vision", "web"], "inputModes": ["text/plain"], "outputModes": ["text/plain"]},
    {"id": "sales", "name": "Sales", "description": "Researches prospects, qualifies pipeline, and drafts approved outbound/follow-up material.", "tags": ["browser", "business", "cron", "delegation", "file_ops", "human", "mcp", "media", "memory", "plugins", "skills", "vision", "web"], "inputModes": ["text/plain"], "outputModes": ["text/plain"]}
  ]
}
```

`_rpc_url(url, card)` -> `http://127.0.0.1:7899/` (from the legacy top-level `url`;
`_select_jsonrpc_interface(card)` -> `None` because there is no `supportedInterfaces`).

## What Hermes reported — `a2a_discover({"url": "http://127.0.0.1:7899"})`, verbatim
```
Agent: Trent Fleet
Description: An autonomous cofounder fleet. One message is one orchestration run across the seats below, and the run's own output comes back as the task artifact.
URL: http://127.0.0.1:7899/
Protocol: v0.3.0 (pre-1.0 card)
Streaming: True  Push: False  Auth required: no
Skills (9):
  - CEO Agent: Prioritizes strategy, roadmap, risks, and operating cycle summaries.
  - Lead Engineer: Plans code changes, GitHub work, tests, and technical architecture.
  - Growth Hacker: Designs acquisition experiments, campaigns, and funnel improvements.
  - Design & Content Lead: Creates design direction, landing copy, docs, and creative briefs.
  - Support & Ops Responder: Drafts replies, mines customer feedback, and handles operational queues.
  - Market & Data Analyst: Researches markets, competitors, and revenue metrics.
  - Finance & Treasury Lead: Tracks spend, margins, budget caps, and financial runways.
  - Critic & Compliance Auditor: Critiques plans and audits risk before irreversible execution.
  - Sales: Researches prospects, qualifies pipeline, and drafts approved outbound/follow-up material.
```

### Field-by-field
| Card field | Hermes `a2a_discover` | Result |
|---|---|---|
| `name`, `description` | read | parsed as-is |
| `url` | read via `_rpc_url` fallback | `http://127.0.0.1:7899/` |
| `protocolVersion` | read only for the label | `v0.3.0 (pre-1.0 card)` — the single warning |
| `supportedInterfaces` | preferred, **absent** | fallback to `url`; no error |
| `capabilities.streaming`, `.pushNotifications` | read | `True`, `False` |
| `capabilities.stateTransitionHistory` | not read | ignored |
| `security` | read (`"yes" if card.get("security")`) | absent -> `Auth required: no` (correct: no token) |
| `securitySchemes`, `supportsAuthenticatedExtendedCard`, `version`, `preferredTransport`, `defaultInputModes`, `defaultOutputModes` | not read | ignored |
| `skills[].name`, `.id`, `.description` | read (first 20) | all 9 listed |
| `skills[].tags`, `.inputModes`, `.outputModes` | not read | ignored — `tags` appears nowhere in `tools.py`/`adapter.py` |

Nothing was rejected. Hermes's parser is tolerant: every `.get()` has a default.

## Wire probe — what a Hermes `a2a_call` would meet (no run, no spend)
Body built with Hermes's own `protocol.text_message(protocol.ROLE_USER, ...)` and posted with the
`A2A-Version: 1.0` header `_http_post_json` adds. Every answer is a validation error Trent returns
from `A2ATaskEngine.begin()` before a task record exists, so no orchestration run started; the
server log shows only the listening line.
```
Hermes v1.0 Message: {"role": "ROLE_USER", "parts": [{"text": "probe: never executed", "mediaType": "text/plain"}], "messageId": "...", "contextId": "ctx-probe"}
POST method='SendMessage'  (what a2a_call sends)      -> {"error": {"code": -32601, "message": "no method \"SendMessage\" on this agent"}}
POST method='message/send' (0.3 name, v1.0 part shape) -> {"error": {"code": -32005, "message": "this agent accepts text parts only"}}
POST method='message/send' with {}   (control)        -> {"error": {"code": -32602, "message": "message/send requires a `message` with at least one non-empty text part"}}
```
Hermes's INBOUND adapter, by contrast, accepts both spellings (`_METHOD_TABLE` in `adapter.py`:
`SendMessage` / `message/send`, `SendStreamingMessage` / `message/stream`, ...), but its OUTBOUND
client sends only the v1.0 names, and `A2A-Version` other than `1.0`/`1.0.0` is refused inbound.

## The other direction — a Hermes card against Trent's spec
Trent has no A2A client and no runtime card validator (`a2a/spec.ts` is types only), so "Trent's
card validation" is the `A2AAgentCard` type. A Hermes card was built OFFLINE with Hermes's pure
`protocol.build_agent_card(...)` + `skills_from_toolsets(...)` (no gateway, no model, no
`~/.hermes` config), then type-checked as an `A2AAgentCard` literal:
```json
{
  "name": "Hermes (probe)",
  "description": "probe card built offline",
  "url": "http://127.0.0.1:9900",
  "version": "1.0.0",
  "provider": {
    "organization": "Hermes Agent",
    "url": "http://127.0.0.1:9900"
  },
  "supportedInterfaces": [
    {
      "url": "http://127.0.0.1:9900",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ],
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": false,
    "extendedAgentCard": false
  },
  "defaultInputModes": [
    "text/plain"
  ],
  "defaultOutputModes": [
    "text/plain"
  ],
  "skills": [
    {
      "id": "toolset.terminal",
      "name": "terminal",
      "description": "Hermes 'terminal' capabilities",
      "tags": [
        "terminal",
        "terminal"
      ]
    },
    {
      "id": "toolset.web",
      "name": "web",
      "description": "Hermes 'web' capabilities",
      "tags": [
        "web",
        "web_search"
      ]
    }
  ]
}
```
`tsc` exit 2: `TS2739: ... is missing the following properties from type 'A2AAgentCard':
protocolVersion, preferredTransport`. Extra fields Trent's type does not know: `supportedInterfaces`,
`capabilities.extendedAgentCard`. Nothing in Trent consumes a card today, so no runtime defect;
it is the same v1.0-vs-0.3 gap seen from the other side. Note the Hermes builder also emits a
duplicated tag (`["terminal", "terminal"]`) when a toolset's tool name equals the toolset name —
a Hermes quirk, recorded and not acted on.

## Why no code change to the card
The task's fix rule was "a field Hermes's parser expects that Trent's card lacks". The only such
field is `supportedInterfaces`, which Hermes reads first but does not require. Adding it would
make `a2a_discover` print `Protocol: JSONRPC v1.0` for an endpoint that then refuses `SendMessage`
with `-32601` — a card lying about its protocol, which `card.ts` exists to prevent. The honest fix
is the RPC layer, which is a planned protocol upgrade (below), not a card edit, and not a
change this proof authorises.

## The defect the proof DID expose, and what changed
`docs/a2a.md`, the `card.ts` docblock and the `card.test.ts` header all said Hermes's
`a2a_orchestrate` "fans a message out to the peers whose skills carry that capability as a tag".
Hermes source (`tools._match_peers_by_capability`) matches `capability` against
`config.yaml a2a_agents.<peer>.capabilities` — the operator's list, never the card; `tags` is
not read anywhere in the Hermes client. The three prose passages were corrected to say that the
tags are what a peer's operator copies into that list, and `docs/a2a.md` gained an "Interop status
with Hermes" section with the wire evidence above. The two `.ts` edits are comment-only
(`git diff` on them shows no non-comment line); the assertions in `card.test.ts` are unchanged
and still the right ones, so no new failing test was needed. `vitest run packages/trent-core/src/a2a`
exit 0 (32 tests); trent-core `tsc --noEmit` exit 0. Files stay under 500 lines
(card.ts 96, card.test.ts 36, docs/a2a.md 159).

## Follow-up (not done here; needs a plan and RED tests first)
Make Trent callable from a Hermes peer: accept the v1.0 method names (`SendMessage`,
`SendStreamingMessage`, `GetTask`, `CancelTask`) beside the 0.3 ones in `rpc.ts`; accept v1.0
`Message`s (`ROLE_USER`, parts discriminated by member presence, `mediaType`) in
`TaskLifecycle.begin`; answer a v1.0 request with the v1.0 `{"task": ...}` envelope and
`TASK_STATE_*` states; and only then publish `supportedInterfaces` on the card. Until then a
Hermes `a2a_call` to Trent fails as shown above, and `docs/a2a.md` says so.

## Files
- `docs/sessions/2026-09-20-hermes-a2a-discovery-proof.md` (this log, new)
- `docs/a2a.md` (tags paragraph corrected; interop status section added)
- `packages/trent-core/src/a2a/card.ts` (docblock corrected, comment only)
- `packages/trent-core/src/a2a/card.test.ts` (header corrected, comment only)
- Scratch (not in the repo): `<scratch>/hermes_discover.py`, `hermes_wire_probe.py`,
  `hermes-parsed-card.json`, `hermes-card.json`, `typecheck/hermes-card-vs-trent-spec.ts`,
  `a2a-serve.log`.

## Scripts
`hermes_discover.py`:
```python
"""Call Hermes's own A2A client code against a running Trent server. No model, no gateway."""
import json, sys, urllib.request
sys.path.insert(0, "/Users/bobbymeher/.hermes/hermes-agent")
from plugins.platforms.a2a import tools, protocol

url = sys.argv[1]
card = tools._fetch_card(url, {}, 30)
print("== _fetch_card returned type:", type(card).__name__, "keys:", sorted(card.keys()))
print("== _rpc_url(card):", tools._rpc_url(url, card))
print("== _select_jsonrpc_interface(card):", tools._select_jsonrpc_interface(card))
print("== which well-known path answered first:")
for path in ("/.well-known/agent-card.json", "/.well-known/agent.json"):
    with urllib.request.urlopen(url.rstrip("/") + path, timeout=10) as r:
        print("   ", path, "->", r.status)
print("== a2a_discover({'url': ...}) output, verbatim:")
print(tools.a2a_discover({"url": url}))
print("== fields Hermes's a2a_discover READS from the card:")
read = ["name", "description", "url", "protocolVersion", "supportedInterfaces", "capabilities.streaming",
        "capabilities.pushNotifications", "security", "skills[].name", "skills[].id", "skills[].description"]
print("   ", read)
print("== top-level fields on Trent's card that a2a_discover never reads:")
print("   ", sorted(set(card) - {"name", "description", "url", "protocolVersion", "supportedInterfaces", "capabilities", "security", "skills"}))
print("== skill fields present on the card:", sorted({k for s in card["skills"] for k in s}))
print("== skill fields a2a_discover reads: name, id, description  (tags are NOT read: capability fan-out uses config.yaml a2a_agents.*.capabilities)")
print("== Hermes wire constants: PROTOCOL_VERSION =", protocol.PROTOCOL_VERSION, "; outbound method =", "SendMessage", "; header A2A-Version =", protocol.PROTOCOL_VERSION)
json.dump(card, open(sys.argv[2], "w"), indent=2)
```
`hermes_wire_probe.py`:
```python
"""POST the JSON-RPC body Hermes's _send_task builds, to Trent, WITHOUT going through _send_task
(which would audit/persist under HERMES_HOME). Every response here is a validation error Trent
returns before a task is created, so no orchestration run and no model call can happen."""
import json, sys, urllib.request
sys.path.insert(0, "/Users/bobbymeher/.hermes/hermes-agent")
from plugins.platforms.a2a import protocol

url = sys.argv[1]
msg = protocol.text_message(protocol.ROLE_USER, "probe: never executed", context_id="ctx-probe")
print("== Hermes v1.0 Message as built by protocol.text_message:", json.dumps(msg))

def post(method, params):
    body = {"jsonrpc": "2.0", "id": "probe-" + method.replace("/", "-"), "method": method, "params": params}
    hdrs = {"Content-Type": "application/json", "A2A-Version": protocol.PROTOCOL_VERSION}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        print(f"== POST method={method!r} -> HTTP {r.status}:", r.read().decode())

post("SendMessage", {"message": msg})     # what Hermes a2a_call actually sends (v1.0 name)
post("message/send", {"message": msg})    # the 0.3 name Trent knows, with the v1.0 part shape
post("message/send", {})                  # control: 0.3 name, no message at all
```
