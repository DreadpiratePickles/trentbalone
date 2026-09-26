# MCP servers

Trent can use tools from any Model Context Protocol server you configure. Each server becomes a
set of tools named `mcp_<server>_<tool>` that the seats call like every other tool, behind the
same approval spine. The other direction, Trent AS an MCP server for Claude Code, Codex, Grok
Build or the xAI API, is [`trent mcp serve`](#trent-as-an-mcp-server) below.

## Configuration: `mcp_servers`

`~/.trent/config.yaml` (or the profile's `config.yaml`):

```yaml
mcp_servers:
  filesystem:                       # stdio: a local process
    transport: stdio                # inferred from `command` when omitted
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/projects"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"   # resolved from the process env at connect time
    auto_approve: [list_directory, read_file]
  remote:                           # http: a Streamable HTTP endpoint
    transport: http                 # inferred from `url` when omitted
    url: https://mcp.example.com/mcp
    headers:
      Authorization: "Bearer ${MCP_TOKEN}"
    enabled: true
```

Rules, enforced by the zod schema in `packages/trent-core/src/config/schema.ts`:

- Names match `^[a-z][a-z0-9_-]{1,40}$` and become the middle of every tool name.
- `transport` is `stdio` (`command`, `args`, `env`) or `http` (`url`, `headers`). This is the
  same block Hermes reads from `~/.hermes/config.yaml`.
- `env` and `headers` values may reference `${ENV_VAR}`. The reference is stored as written and
  resolved only when Trent connects; a missing variable makes the server unavailable and the
  reason names the variable, never a value.
- `auto_approve` lists the server's own tool names that may run without approval. Everything
  else on that server requires approval on every call.
- `enabled: false` keeps the entry but never connects.
- `scanRan` and `flagged` are written by `trent mcp add` (see the install-time scan below); both
  are optional, so an entry written by hand or by an earlier build reads unchanged.
- The old `[{name, url}]` array written by earlier CLI builds is lifted into http entries on read.

## Managing servers from the CLI

```
trent mcp list                                   # configured servers + the vetted gallery
trent mcp add fs --command npx --args -y @modelcontextprotocol/server-filesystem /path \
    --env GITHUB_TOKEN='${GITHUB_TOKEN}' --auto-approve read_file list_directory
trent mcp add remote --url https://mcp.example.com/mcp --header 'Authorization=Bearer ${MCP_TOKEN}'
trent mcp test remote                            # connects and lists the tools it exposes
trent mcp remove fs
```

Every subcommand takes `--json` and `--dry-run`. `add` refuses a name that collides with a
built-in Trent tool (`tools/tool-names.ts`), a duplicate, a bad name, and a literal secret: an env
var whose name looks secret (`*_TOKEN`, `*_KEY`, ...) or a credential header (`Authorization`,
`Cookie`, `X-Api-Key`, ...) must carry a `${ENV_VAR}` reference.

### Install-time scan

`add` connects to the server once, runs `tools/list`, and scans every string the server would
hand a seat as instructions: each tool's name, its description, and every `description` or
`title` inside its input schema. The scanner is `skills/SecurityScan`, the same jailbreak and
exfiltration patterns a SKILL.md must pass (`ignore all previous instructions`, `system override
mode`, `webhook: https://...` off-domain, `curl ... | sh`, reads of `~/.ssh`, ...).

- A finding refuses the add with exit code 3. The error names the tool and the finding category
  (`helper [Prompt injection / jailbreak attempt]`), never the matched text: the text is the
  attack, and echoing it would put it in a log a seat might later read. Nothing is written.
- `--allow-flagged` installs anyway. The findings are stored on the server's own entry as
  `flagged: [{ tool, categories }]` (categories only, never the matched text), `mcp list` shows it
  as flagged, and one warning line goes to stderr. `mcp remove` removes the entry and the record
  with it.
- Every entry `add` writes carries `scanRan`. A server that cannot be reached at add time (stdio
  command missing, http with no egress proxy running) is stored with `scanRan: false`; the `--json`
  result carries the reason. Run `trent mcp test <name>` once it is reachable.

### Result scrubbing

Every `callTool` result passes through the secret detectors of the prompt redactor
(`model-gateway/redact.ts`, T3.2) before it reaches the seat: provider API keys, bearer and
basic credentials, `Authorization`/`X-Api-Key` header values, JWTs, AWS key ids and named
secrets, private-key blocks, connection-string passwords and `api_key=`/`password=` pairs become
numbered tokens such as `[REDACTED:api-key#1]`. PII stays: an MCP result legitimately carries
emails and phone numbers, so the prompt pass's PII detectors are not applied, and neither is the
generic long-base64 sweep, which would blank a git SHA or an encoded payload the seat asked for.
Hit counts per kind are logged as `mcp.result.redacted` (server, tool, kinds, counts); values
never are. Implemented in `packages/trent-core/src/tools/mcp/scan.ts`.

## How the toolset behaves

Implemented in `packages/trent-core/src/tools/mcp/`.

- **One adapter, `mcp`**, whose scopes are `mcp_status` plus one `mcp_<server>_<tool>` per
  discovered tool, each carrying the server's JSON input schema in the seat instructions.
  Hermes names the same tool `mcp__<server>__<tool>`; the components are sanitised the same way.
- **Discovery is real.** At build time Trent connects to every enabled server, runs
  `tools/list`, and keeps the connection open for the seat's life. `cleanup()` closes it.
- **Unavailable is never silent.** A server that fails to connect, cannot list tools, is
  disabled, or references an unset variable is reported with its reason in `mcp_status`, in the
  adapter's instructions and in `createMcpAdapters(...).unavailable`. The other servers still work.
- **Approval.** `requiresApproval` is true for every MCP tool unless it is in the server's
  `auto_approve`. `mcp_status` never needs approval.
- **stdio isolation.** The child gets the scrubbed host env from `terminal/env-scrub.ts` (PATH,
  HOME, locale, ... and nothing that looks like a secret) plus only the vars declared in `env`.
  Its stderr is discarded so a server can never echo a value into a summary or log.
- **http goes through egress.** Requests use the egress fetch from `tools/web` (CONNECT through
  the proxy, SSRF floors re-checked on every hop) after `checkUrlSafety` refuses private,
  loopback and cloud-metadata targets. Without the egress proxy an http server is unavailable.
  The server's own credential never passes through the broker: every request carries the
  proxy's own-credential marker (`x-trent-own-credential`), so the `headers` the entry configures
  (an `Authorization` bearer, an `X-Api-Key`) arrive as written, a server configured with none
  receives none, and the credential the proxy's token stands for (the model provider key in the
  REPL) is never written in their place (`tools/mcp/egress.test.ts`).
- **Results follow the spillover rule.** Output over `SUMMARY_LIMIT` is written to
  `<profile>/cache/spillover/` and the summary keeps a head/tail window plus the path.

## OAuth 2.1 for remote servers

Implements the MCP authorization specification, revision **2026-07-28**
([authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[server discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery),
[client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration),
[security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)),
in `packages/trent-core/src/tools/mcp/http-oauth-wire.ts`, `http-oauth.ts`, `http-oauth-store.ts` and
`http-transport.ts`, on the `trent connect` loopback listener, PKCE helpers and refresh lock.

```
trent mcp add remote --url https://mcp.example.com/mcp --oauth  # browser login first, then the entry
trent mcp list                                                  # oauth: connected | expired | needs-login
trent mcp test remote --oauth                                   # log in again, then connect
trent mcp remove remote                                         # the entry and its OAuth state
```

**The flow.** A person starts it (`add --oauth`, `test --oauth`); a seat or a cron job never opens a
browser.

1. An `initialize` POST with no credential; the 401's `WWW-Authenticate: Bearer` challenge gives
   `resource_metadata` and `scope` (RFC 6750 section 3).
2. Protected-resource metadata (RFC 9728): the challenge's URL, else
   `/.well-known/oauth-protected-resource/<path>`, then the root. Its `resource` must be this server's
   URL (or its origin), or the document is not used (section 3.3).
3. Authorization-server metadata: RFC 8414 path insertion, then OpenID Connect path insertion, then
   path appending. The document's `issuer` must be identical to the one the URL was built from, and
   `code_challenge_methods_supported` must list `S256`; absent, the login refuses to proceed.
4. The client: the one this profile registered with that same issuer, else RFC 7591 registration of a
   native public client (`application_type: native`, `token_endpoint_auth_method: none`) for the
   exact loopback redirect URI `http://127.0.0.1:<port>/callback`.
5. The browser: authorization code with S256 PKCE, `state`, and `resource` (RFC 8707, the canonical
   server URI); the scope is the challenge's, else `scopes_supported`, plus `offline_access` when the
   authorization server lists it. The loopback listener refuses a callback whose `state` differs, and
   one whose `iss` is not the recorded issuer (RFC 9207; an absent `iss` too when the metadata promised
   it), before the code is used.
6. The token request carries the verifier, the same redirect URI and the same `resource`.

**Where the tokens live.** The profile secrets file (`<profile>/.env`, mode 0600, written atomically by
`ConfigManager.saveSecrets`), under names derived from the server name (upper case, `-` becomes `_`):
`MCP_<NAME>_ACCESS_TOKEN`, `_REFRESH_TOKEN`, `_TOKEN_EXPIRES_AT`, `_TOKEN_SCOPES`, and the client:
`_OAUTH_CLIENT_ID`, `_OAUTH_CLIENT_SECRET` (only when the server issued one), `_OAUTH_CLIENT_AUTH`,
`_OAUTH_ISSUER`, `_OAUTH_TOKEN_URL`, `_OAUTH_RESOURCE`, `_OAUTH_REDIRECT_URI`. `config.yaml` holds only
`headers.Authorization: "Bearer ${MCP_<NAME>_ACCESS_TOKEN}"`, the reference that marks an entry as
OAuth-managed. Nothing prints a value: results and `list` carry names, the issuer and the expiry.

**At connect time.** The bearer goes on every request, never in a query. It is renewed when it is
within five minutes of expiry, and once more when the server answers 401 (then the request is retried
once), under the same refresh lock `trent connect` uses, so racing seats produce one refresh; a rotated
refresh token replaces the old one. With nothing to renew the server is unavailable and the reason
says `log in with trent mcp test <name> --oauth`; `trent doctor` says the same on its MCP line for an
expired token or a server nobody logged in to. The refresh goes through the egress proxy with the
own-credential marker, so the broker adds nothing to it: put the authorization server's token host in
`egress.intercept_domains` beside the MCP host.

**Where a bearer may go.** Only to the MCP server's origin. A redirect is followed only to the same
origin (or the same host upgraded to https) and a cross-origin one is refused by name, for an OAuth
bearer and a static `Authorization` header alike (before this, the egress fetch re-sent the configured
header to whatever host a 307 named; `tools/mcp/http-egress.test.ts`). Metadata, registration and token
requests are never redirected, every URL passes the SSRF floor first, and an authorization-server
endpoint must be https unless the MCP server itself was configured over plain http.

**What a server must support.** A 401 with a `Bearer` challenge (ideally carrying `resource_metadata`)
or protected-resource metadata at a well-known URI; an authorization server with RFC 8414 or OpenID
Connect metadata whose `issuer` matches, `S256` in `code_challenge_methods_supported`, https endpoints,
and RFC 7591 registration that accepts a loopback redirect URI (Trent reuses the registered port when it
is free, and registers again when it is not). `resource` is always sent; `iss` is checked when present.

Not implemented: Client ID Metadata Documents (Trent hosts no HTTPS client document), entering a
pre-registered client, and step-up re-authorization on a 403 `insufficient_scope`. From the CLI the
login runs on the process network like `trent connect`, but `add` and `test` still cannot connect to an
http server afterwards, because the CLI runs no egress proxy (unchanged; a seat can).

## Wiring

`createMcpAdapters(config, deps)` (async) returns `{ adapters: [mcp], unavailable }`;
`createMcpAdapter(config, deps)` (sync) returns the same adapter with a `ready` promise, for the
synchronous tool builder. Both take `{ profileDir, env?, egress?, cwd?, connectTimeoutMs? }`.


## Trent as an MCP server

```
trent mcp serve                                   # stdio: the host spawns this process
trent mcp serve --http                            # Streamable HTTP on http://127.0.0.1:7896/mcp
trent mcp serve --http --host 0.0.0.0 --port 7896 --token-env TRENT_MCP_TOKEN
```

Implemented in `packages/trent-core/src/mcp-server/` and `apps/cli/src/commands/groups/mcp-serve.ts`.
The server exposes this profile's enabled TOOLSETS as MCP tools, one MCP tool per Trent tool, with
the schema each adapter publishes (`tools/list` answers with `read_file`, `write_file`, `patch`,
`search_files`, `terminal`, `process_manage`, `web_search`, `web_extract`, `execute_code`,
`delegate_task`, `cronjob_manage`, `skills_list`, ... and the brain tools `memory`, `fleet_search`,
`fleet_skill_view`, `brain_read`, plus `todo` and `session_search`). It does not expose seats: a
seat-targeted runner does not exist yet (design v2, decision C); the A2A server runs whole
orchestrations.

What a call crosses. The adapters are the ones the headless runtime built for a seat
(`buildTrentTools`), so a call from a host crosses the same chain a seat's call crosses, in the
same order: the provenance tag, then the hardline blocklist, `approvals.deny` globs, the approval
floors and the autonomy level, the pre-tool hooks, the policy rules, idempotency, the adapter, the
post-tool hooks (`tools/index.ts`, `buildTrentTools`). A tool
disclosure has deferred (`tools.disclosure_threshold`, every MCP and plugin tool) is called
through the bridge's `tool_call`, which re-enters that chain. Every connection is one run
(`mcp_<hex>`): idempotency keys and approval rows name it, and the runtime is opened on the `mcp`
surface, so a delegated run or a vision call made through it is charged to `mcp` on the spend
ledger (`trent budget status`).

Approvals are never silent. A call the gates hold comes back as a tool result, not an error:

```json
{
  "content": [{ "type": "text", "text": "needs_approval appr_1758...: file_ops: would write notes/a.md ..." }],
  "structuredContent": {
    "status": "needs_approval",
    "tool": "write_file",
    "adapter": "file_ops",
    "surface": "mcp",
    "approval_id": "appr_1758...",
    "preview": "file_ops: would write notes/a.md ...",
    "settle": "trent approvals approve appr_1758... (or reject); then call again with the same arguments"
  },
  "isError": false
}
```

The row lands in this profile's `gateway.json`, listed by `trent approvals list` with the host's
name (`mcp:claude-code`). The founder settles it there; the host calls the same tool with the same
arguments; the server finds the row by the key of the call (run, tool, arguments), runs it once,
and marks the row spent, so the next identical call asks again. A rejected row stays rejected for
that call: the result is `blocked`, not a new question. A hardline refusal, a deny glob and a
floor come back as `blocked` with `isError: true` and the rule named. Two tools are not exposed:
`ask_human` and `clarify` are answered through a Trent surface the host does not have; the host
agent asks its own user.

Results are scrubbed with the same secret detectors an MCP result reaching a seat passes
(`scrubMcpResult`); hit counts go to stderr as `mcp.serve.result.redacted`, values never do.

Transports. stdio is the default and is a subprocess protocol: nothing but MCP messages goes to
stdout, logs go to stderr, and the command returns when the host closes the pipe. `--http` binds
one endpoint, `/mcp`, POST and GET, sessions by `Mcp-Session-Id`, each session its own Trent
server and run. It binds `127.0.0.1` by default. A non-loopback `--host` refuses to start without
a bearer token, before a socket or a runtime exists, for the reason the A2A card gives: an absent
token means anyone may call. The token is the value of the variable `--token-env` names
(`TRENT_MCP_TOKEN` by default; put it in the profile secrets file with
`trent config set TRENT_MCP_TOKEN <value>`, which exports it), presented as `Authorization:
Bearer <token>`, compared in constant time, and never printed. `Origin` is validated on every
request: a browser origin that is not loopback gets 403, the specification's DNS-rebinding rule.

Client configuration:

```json
// Claude Code: .mcp.json in the project (Grok Build reads the same file)
{
  "mcpServers": {
    "trent": {
      "command": "trent",
      "args": ["mcp", "serve", "--stdio", "--profile", "default"],
      "env": { "TRENT_QUEUE_FALLBACK": "disabled" }
    }
  }
}
```

```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.trent]
command = "trent"
args = ["mcp", "serve", "--stdio", "--profile", "default"]

[mcp_servers.trent.env]
TRENT_QUEUE_FALLBACK = "disabled"

# Grok Build: ~/.grok/config.toml, over HTTP with the bearer
[mcp_servers.trent]
url = "http://127.0.0.1:7896/mcp"
bearer_token_env_var = "TRENT_MCP_TOKEN"
```

Claude Code names the tools `mcp__trent__<tool>` (`mcp__trent__read_file`); that is what
`trent fleet export --target claude` writes into a subagent's `tools:` line
([fleet.md](fleet.md#exporting-to-claude-code-and-grok-build)). The xAI Remote MCP API
(`server_url`, `authorization`) needs the HTTP transport reachable from xAI, therefore a
non-loopback bind and a token; it cannot relay an interrupt, which is why an approval is a result
the model reads rather than a prompt the API would have to show.

Every subcommand takes `--json` and `--dry-run`; `--dry-run` reports the transport, host and port
and builds nothing.

## Not implemented

Server-side: resources and prompts (tools only), OAuth (a bearer or nothing), seats as tools
(decision C: after a seat-targeted runner exists), and the legacy HTTP+SSE transport.

Client-side: SSE transport, resources and prompts (OAuth: see [above](#oauth-21-for-remote-servers)), Hermes's tool-definition drift checks (the
scan runs at `add` and on `test`; a server that changes a description after install is not
re-scanned at connect time) and its OSV malware preflight for `npx` servers. The read-only app's `mcp-tool-adapter.ts` keeps its
own per-company registry; this toolset is the CLI/desktop profile equivalent.
