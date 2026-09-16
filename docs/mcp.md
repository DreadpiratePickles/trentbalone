# MCP servers

Trent can use tools from any Model Context Protocol server you configure. Each server becomes a
set of tools named `mcp_<server>_<tool>` that the seats call like every other tool, behind the
same approval spine.

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
- **Results follow the spillover rule.** Output over `SUMMARY_LIMIT` is written to
  `<profile>/cache/spillover/` and the summary keeps a head/tail window plus the path.

## Wiring

`createMcpAdapters(config, deps)` (async) returns `{ adapters: [mcp], unavailable }`;
`createMcpAdapter(config, deps)` (sync) returns the same adapter with a `ready` promise, for the
synchronous tool builder. Both take `{ profileDir, env?, egress?, cwd?, connectTimeoutMs? }`.

## Not implemented

SSE transport, OAuth flows, resources and prompts, Hermes's tool-definition drift checks (the
scan runs at `add` and on `test`; a server that changes a description after install is not
re-scanned at connect time) and its OSV malware preflight for `npx` servers. The read-only app's `mcp-tool-adapter.ts` keeps its
own per-company registry; this toolset is the CLI/desktop profile equivalent.
