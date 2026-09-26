# Security model

The property this page is about: a process that runs agent-authored code never holds a real API key,
and cannot reach a host nobody allowlisted.

The closest comparable tool has no equivalent. Hermes has no TLS interception, no CA injection, no
egress allowlist, and its `docker-compose.yml` runs `network_mode: host` for both services, which
removes container network isolation entirely. What it calls a proxy is a credential-attaching
forwarder that never mediates request bodies. Its real protection is process-boundary environment
scrubbing, which is genuine but weaker. Brokering credentials at the boundary is therefore a
difference in kind, not a feature comparison.

## Egress credential brokering

The sandbox holds an opaque token. The host holds the secret. They meet only inside the proxy.

```
sandboxed process                    egress proxy (host)              upstream API
  OPENAI_API_KEY=trnt_egress_…  ──▶   1. CONNECT: host in            ──▶  real key in
  HTTPS_PROXY=127.0.0.1:8089             intercept_domains?                the header
  NODE_EXTRA_CA_CERTS=…/ca.crt        2. terminate TLS with a
                                         cert this CA just issued
                                      3. token resolves to a secret?
                                      4. swap token for secret
```

Deny by default, enforced twice. Once at the CONNECT handshake, where the host must appear in
`egress.intercept_domains`. Again on the decrypted request, where a presented token must resolve to a
stored credential. No code path originates an upstream connection before both checks pass. When no
token resolves, the proxy answers with a refusal and the request is not forwarded:

```json
{ "error": "egress_refused", "reason": "no_resolvable_token",
  "message": "Trent egress proxy refused this request: no valid broker token was presented. The request was NOT forwarded." }
```

The previous implementation had no CONNECT handler at all, so HTTPS could not tunnel through it, and
when no token resolved it forwarded anyway. That made it an open relay. It also never consulted
`intercept_domains`.

### The allowlist

`egress.intercept_domains` takes exact hostnames or a `*.example.com` wildcard covering one or more
leading labels. Matching is case-insensitive and port-stripped. An empty list matches nothing: deny
by default, including on a misconfiguration.

Defaults are `api.openai.com`, `api.anthropic.com` and `generativelanguage.googleapis.com`.

```bash
npm run cli -- egress setup --port 8089
npm run cli -- egress start --dry-run     # would start egress proxy on port 8089
npm run cli -- egress start               # binds and stays alive
```

### Tokens

Tokens are prefixed `trnt_egress_` and stored through a `TokenStorePort`, defaulting to a file store
at `~/.trent/egress/tokens.json`. The earlier version was an in-memory `Map`, so a revocation issued
in one CLI invocation had no effect on a proxy already running, and a restarted proxy re-opened
nothing. Storage is now durable, so revocation crosses a restart.

The proxy reads a token from `x-trent-proxy-token`, `authorization`, `x-api-key` or
`x-goog-api-key`, so an unmodified SDK works without knowing the proxy exists.

A token's secret is bound to the host(s) it belongs to (`hosts` on the record, `host` or
`host:port`; `egress/host-binding.ts`). The REPL mints its token bound to the host the configured
provider's model calls go to, as `doctor/endpoint.ts` resolves it (so a moved `OPENAI_BASE_URL`
and a local runtime's `127.0.0.1:<port>` are honoured). A request to any other allowlisted host
is still forwarded, but without the secret: the proxy removes only what carries the broker token
and its own headers, so a caller's own key (a search API's) passes intact, and it writes one
`egress.secret_withheld` warning per token and host naming the host, never the secret or the
token. This matters because the sandbox holds the one token in every provider key variable and
the default allowlist names three providers: before binding, a Gemini profile's key reached
api.openai.com, and any business or search host the owner allowlisted received the model key. A
record with no `hosts` (minted before binding, or by a caller that named none) is bound to
nothing and injects its secret nowhere: fail closed.

Every request Trent sends through the egress proxy honours `redirect: "error"` and `"manual"`, and a
followed redirect to another origin drops `Authorization`, cookies, API-key headers, the proxy token and the
request body (a 301/302/303 POST becomes a GET; a 307/308 that would re-send a body elsewhere is refused), so an
A2A peer's bearer never reaches the host its 302 names (`a2a/client-redirect.test.ts`,
`tools/web/proxied-fetch.test.ts`).

### The local certificate authority

TLS interception needs a certificate the sandbox trusts. Node's `crypto` can verify X.509 but cannot
issue it, so key material is generated with `generateKeyPairSync` — audited, no JavaScript PRNG — and
only the certificate structure and signature go through `node-forge`.

The CA private key is written 0600, lives in `~/.trent/egress/`, and never leaves the host. Only the
public certificate is mounted into a sandbox, at
`/usr/local/share/ca-certificates/trent-egress-ca.crt`.

## What the sandbox can and cannot see

The child environment is built in exactly one place, `packages/trent-core/src/egress/SandboxEnvironment.ts`,
so there is one function to audit.

Can see:

- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` — each holding the
  opaque token, under its normal name so unmodified SDKs work.
- `TRENT_PROXY_TOKEN`, the same token by its own name.
- `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy` pointing at the local proxy.
- The CA certificate path, and whatever non-secret base environment the caller passes.

Cannot see:

- Any real provider key. Callers must not merge `process.env` into the result, and the docker
  backend builds its `--env` arguments from this function's output only.
- Anything outside the allowlist, because every outbound connection goes through the proxy.

If an agent prints its whole environment, or logs every outgoing request header, the worst it leaks
is a revocable token that only works from this host through this proxy.

## Sandbox execution

`DockerBackend` spawns every process with `execFile` and an argument array. No host shell is ever
involved. The only shell that sees an agent-authored command is `sh -c` inside the container, which
receives it as one opaque argv element. The previous version built
`docker run --rm … sh -c "<command>"` as a single string and handed it to `child_process.exec`, so
the host shell parsed the command, the working directory and every environment value — a command
injection reachable by any agent-authored string. It also set no network flags, so the sandbox could
reach whatever the host could.

`LocalBackend` is named "Local Execution Backend (Development Only)" for a reason: it runs commands
on the host with the host's environment. It is not a sandbox.

## File permissions

| Path | Mode | Enforced by |
|---|---|---|
| `~/.trent/.env` and `profiles/*/.env` | 0600 | Written atomically with the mode re-asserted; `doctor --fix` chmods it |
| `~/.trent/sessions/*.json` | 0600 | `SESSION_FILE_MODE`, re-asserted on every write |
| the sessions directory | restricted | `SESSION_DIR_MODE`, best effort |
| `~/.trent/egress/ca.key` | 0600 | Written by the certificate authority |
| `~/.trent/keys/audit.key` and `profiles/*/keys/audit.key` | 0600 in a 0700 directory | Generated on first use by `trent audit`; the export and `.sig` are 0600 too |
| `profiles/*/checkpoints/*/ledger.jsonl` and its `blobs/` | 0600 in a 0700 directory | The agent-write ledger and its pre-images, written temp-then-rename with the mode re-asserted; a pre-image of a workspace file never leaves the profile (docs/checkpoints.md) |

Provider credentials and OAuth tokens taken by `trent connect` (docs/connect.md) go to the same
`.env` through the same write, and to nowhere else: not `config.yaml`, not a log, not an output.

Session files were 0644 in a 0755 directory before this was hardened. Every write is now
write-then-rename with the mode re-asserted after the rename, so an interrupted write cannot leave a
world-readable transcript. A directory that cannot be chmodded — a network mount, Windows — still has
to be usable, so that case degrades rather than failing.

## Signed audit export

`trent audit export [--out <file>]` writes the store's `AuditLog` rows as NDJSON — one row per
line, each company's chain from its `genesis` entry forward — and a detached `<file>.sig`: one
JSON line with an Ed25519 signature over the sha256 of the file, the signer's fingerprint
(`sha256:` of the DER public key) and the public key itself. The default file is
`./trent-audit-<date>.ndjson`. Both files are written atomically, 0600.

The signing key is generated on first use at `<profile>/keys/audit.key` (PKCS8 PEM, 0600, in a
0700 directory) with the public key beside it as `audit.pub`. `trent audit key` prints the public
key and fingerprint; nothing prints the private key, and `.sig` never carries it.

`trent audit verify <file>` runs two independent checks and reports both, so a tampered file is
named by its 1-based line number and by which check it failed:

- **chain** — every row's `hash` is recomputed with the wrapped application's formula
  (`sha256(prevHash + id + actor + action + objectId + summary + createdAt)`, `lib/audit-log.ts`)
  and every `prevHash` must be the previous row of the same company, or `genesis`;
- **signature** — the file's sha256 must be the digest the `.sig` covers and the Ed25519
  signature must verify. When this profile has an audit key, only that key is accepted, whatever
  key the `.sig` embeds; a profile without one verifies against the embedded key and reports
  `trusted: false`, so the caller knows the signer is unvouched for.

`--json` returns `{ ok, rows, signer, trusted, digest, failures[] }`; a failed verification exits
with the authentication code (4). Export refuses with the config code (3) when only the in-process
store is available (plain Node without `bun:sqlite`), because a signed empty file would read as a
clean audit trail.

## The redaction boundary

There is one definition of what a secret looks like. `packages/trent-core/src/errors/` owns it, and
`packages/trent-core/src/telemetry/redact.ts` extends it for long text. The trace exporter used to
carry a private pair of regexes of its own, which meant a shape fixed in one place still leaked from
the other.

Two layers, applied in order to anything that leaves the machine:

1. Transcript-shaped patterns are replaced in place, so an operator still reads
   `ANTHROPIC_API_KEY=[REDACTED_SECRET]` and knows which key to rotate.
2. Every remaining whitespace-delimited token is run past the error layer's `redactText`. If that
   layer would call it a secret, the token is dropped whole.

Nothing the telemetry layer emits can therefore be something the error layer considers a credential.
The error envelope redacts by key name and by value shape, recursively through nested context bags.

Elsewhere the same rule holds by construction. `config get` on a secret prints `[set]`.
`gateway setup --token` returns the name of the secret it configured, never the token. The degraded
banner tests provider keys for presence only and never reads a value into a message. The doctor's
`details` carry a key's length, not its prefix. The Google credential probe puts the key in a header
rather than a query string so it cannot land in a proxy log.

## Prompt redaction

The redaction boundary above covers what leaves the machine as a log or a trace. Prompts leave it
too, and a pasted `.env`, a tool result that printed a connection string, or a customer's email in
an objective would otherwise reach the provider verbatim. `privacy.redact_prompts: true` in
`config.yaml` closes that path at the one point every message passes on its way out: the model
gateway's stream call (`packages/trent-core/src/model-gateway/redact.ts`, applied in `index.ts`
before the provider function is invoked). The orchestrator's planner, critic and consolidator, the
improve loop's judge and gate, the fleet-memory consolidator and the vision tool all go through it;
tool results are messages in the same array, so they are covered without a second pass. Not yet
covered: the seat turns themselves, which `orchestrator/index.ts` runs through the wrapped
application's own `executeSeatModel` (`apps/web/lib`, read-only) rather than through this gateway.
Routing the seat port through the same redactor is the open item for this feature.

What is masked:

- the secret shapes `telemetry/redact.ts` already defines (provider API keys, bearer and basic
  credentials, `Authorization` headers, PEM private key blocks, JWTs, AWS key ids and named
  secrets, passwords in connection strings, `*_API_KEY=` style named credentials, long base64
  runs), reused rather than redeclared, so a shape fixed there is fixed here;
- built-in PII: email addresses, E.164 phone numbers, IPv4 addresses;
- every expression in `privacy.patterns`, compiled at startup; a bad one fails the start with exit
  code 3 and `privacy.patterns[<index>]` in the message;
- as a floor, any remaining whitespace-delimited token the error layer's `redactText` would call
  a secret.

The replacement is a numbered token per kind, `[REDACTED:api-key#1]`, `[REDACTED:email#2]`. Within
one request the same value always maps to the same token, so the model can still refer to it; a new
request starts numbering again, so tokens are never a cross-request identifier. The telemetry rules
keep their surrounding context (`postgres://app:[REDACTED:connection-string#1]@host/db`), so an
operator reading a transcript still knows which credential to rotate.

Per request the gateway logs one structured `prompt.redacted` line with the hit counts per kind and
the message count, and nothing else: the values never reach a log, and the logger refuses payload
fields by name in any case. Redaction off is the identity; the default is off, because a masked
value is also a value the model cannot act on, and the operator decides which trade they want.

## The approval model

An approval blocks input in the REPL and survives a process restart.

`StorePort` has `createApproval`, `getApproval` and `resolveApproval`, but deliberately no
`listApprovals`, so after a restart there is no way to ask the database what is still pending.
Rather than widen a port owned by another module, the gate keeps its own durable index: one `JobRun`
row of type `trent_approval` per approval, whose summary is the approval id. `listJobRuns` returns
the index after a restart, and each approval row remains the single source of truth for its own
status — so a stale index entry for an already-answered approval is harmless.

The test that matters kills the process mid-approval and asserts the approval is still pending and
still answerable, and that the budget and the audit chain persisted with it.

Progressive tool disclosure does not open a way around any of this. Above
`tools.disclosure_threshold` a tool is reached through `tool_call` rather than advertised directly,
and `tool_call` re-enters the same wrapper chain a direct call enters — the autonomy dispatch, the
deny globs, the hardline floor, the policy rules, the hooks and the idempotency store all run for
the inner call, on the inner tool's own name. MCP, plugin and app-catalog tools sit behind that
bridge at any count. See [tools.md](tools.md).

Approval floors are matched over deobfuscated command variants:
`packages/trent-core/src/tools/approval-floors.ts` (`floorBlock`, `dangerous`, `detectionVariants`)
runs every rule in `approval-patterns.ts` (`HARDLINE_PATTERNS`, `DANGEROUS_PATTERNS`, ported from
Hermes `tools/approval_detection.py`) against each variant, so `r\m -rf /`, `rm${IFS}-rf${IFS}/`,
`$(echo rm) -rf ~`, `env rm -rf /` and `sh -c 'rm -rf /'` all reach the same rule; the hardline floor
is checked inside `execute`, not only at `requiresApproval`, so it is never bypassed by an earlier
approval. Tested in `approval-floors.test.ts`.

## Autonomy levels

`autonomy` in `config.yaml` decides how often a human is asked. It never decides whether the floor
below it applies.

| Level | Asks for |
|---|---|
| `ask_always` | every tool call that is not a pure read |
| `ask_dangerous` | exactly where the adapters' own floors already ask (**default**) |
| `never` | nothing the floors would have asked about |

`ask_dangerous` is the default because it is what Trent did before the key existed: `file_ops` asks
on a write, `terminal` and `code_execution` ask on a dangerous finding, `plugins` and `mcp` ask
unless `auto_approve` names the tool, `ask_human` asks unless the call is delegated, and `memory`,
`web`, `delegate`, `vision` and `browser` never ask. Setting the key to `ask_dangerous` changes
nothing; that is the point of naming it.

"Pure read" is decided by the same classifier the policy rules use
(`governance/policy-rules.ts` `classifyCall`): a call is a pure read when `read_only` survives
classification, which it does not once the call also writes, executes, sends, fetches or destroys.
So `read_file` is a pure read, `web_search` is a network call, and a call nothing can classify is
not a pure read — the safe direction for `ask_always`.

Three things are refused at **every** level, behind any `--yolo`-style flag, and after any "always
approve" answer, because an approval is granted loop-wide once a human says yes
(`seat-agent-loop.ts:209`):

1. the hardline blocklist below,
2. an `approvals.deny` glob,
3. anything `tools/approval-floors.ts` `floorBlock` marks never-auto-approvable.

The order is fixed, so the most specific reason is the one reported. All of it is applied in
`governance/autonomy-dispatch.ts`, wrapped around every adapter in `tools/index.ts`
`buildTrentTools` — outside the policy and idempotency wrappers, so a refusal never enters the
policy history ring and never reaches the idempotency store. It runs inside `execute`, not only at
`requiresApproval`, so a second call in an already-approved step still hits it. Tested in
`governance/autonomy.test.ts`, `autonomy-dispatch.test.ts` and `tools/autonomy-wiring.test.ts`.

## The hardline blocklist

`packages/trent-core/src/governance/hardline.ts`. One list, shipped in code, not configurable —
a blocklist a tool call could edit is not a blocklist. Each rule is evaluated on the terminal or
process command string AND on the file paths a tool would touch, and each has a positive and a
negative case in `hardline.test.ts`.

| Rule id | Refuses |
|---|---|
| `recursive-delete-of-root-home-or-profile` | `rm -rf` of `/`, `~`, `$HOME`, `~/.trent` or this profile directory |
| `download-piped-into-a-shell` | `curl`/`wget` piped into a shell, `sh <(curl ...)`, `sh -c "$(curl ...)"`, `eval $(curl ...)` |
| `chmod-or-chown-on-root` | a permission or ownership change applied to `/` |
| `write-to-a-raw-disk-device` | `dd of=/dev/sdX`, a redirect to a raw device, `mkfs` |
| `fork-bomb` | a function whose body pipes itself into itself in the background |
| `write-to-trent-secrets` | a write to `~/.trent/.env`, the egress `ca.key`/`ca.crt`/`tokens.json`, or `workspace-trust.json` |
| `read-trent-env-or-ssh-keys` | a read of `~/.trent/.env`, of anything under `~/.ssh`, or of Trent's own keys: `keys/*.key` (the audit signing key), `egress/ca.key` and `egress/tokens.json` under `~/.trent` or the profile directory (`governance/hardline.test.ts`) |
| `force-push-to-a-protected-branch` | `git push --force` (or `-f`, or a `+refspec`) naming `main`, `master`, `trunk`, `develop`, `release`, `production` or `prod` |

Commands are matched over the deobfuscated variants the approval floor already generates
(`detectionVariants`: NFKC, ANSI and escape strip, `$IFS`, env unwrap, basename projection, `sh -c`
payloads), so `r\m -rf /` and `rm${IFS}-rf${IFS}~` reach the same rule as the plain spelling. Rules
that could otherwise fire on prose are matched over quote-masked variants, so
`git commit -m 'never rm -rf /'` is a commit, not a refusal. Paths have `~` and `$HOME` expanded and
`..` collapsed before they are compared.

**This is a guardrail, not a sandbox.** It raises the cost of an accident and of an obvious injected
instruction. It does not contain an attacker who already runs code as the user: a command can always
be spelled another way, and a list that matched every spelling would refuse ordinary work. The
containment boundary is the sandbox (`tools/sandbox.ts`) and the egress proxy. Read this list as
"not even once, not even approved", never as "cannot happen".

Two gaps are deliberate and named rather than hidden: reading the egress `ca.key` is not on the
list (only writing it is), and `~/.ssh` writes are left to the `DANGEROUS_PATTERNS` approval tier
rather than being refused outright.

## Deny globs

`approvals.deny` in `config.yaml` is a list of globs matched against the same subjects the hardline
list sees: the command string and the file paths. A match is refused at every autonomy level, with
the glob named in the refusal so the user can find and edit the rule that fired.

```yaml
approvals:
  deny:
    - "*terraform destroy*"
    - "~/Documents/**"
    - "*/prod-secrets/*"
```

One glob dialect, deliberately: `*` and `**` both match any run of characters **including** `/`,
`?` matches exactly one character, everything else is literal, matching ignores case, and a leading
`~` expands against the home directory. Path globbing usually stops `*` at a separator, but these
globs are matched against command strings as often as against paths, and `*rm -rf /tmp*` failing
because the command contains a slash is a footgun that costs more than the precision buys. The
first configured glob that matches is the one reported, so the message is stable across runs.
Tested in `governance/deny-globs.test.ts`.

## User hooks

`hooks` in `config.yaml` runs a command of the user's around every tool call and around a session.
Four kinds: `pre_tool_call`, `post_tool_call`, `session_start`, `session_stop`.

```yaml
hooks:
  pre_tool_call:
    - command: ["/usr/local/bin/trent-gate", "--strict"]
      timeout_ms: 3000
      match: { tool: terminal }
  post_tool_call:
    - command: ["/usr/local/bin/trent-audit"]
```

**`command` is an argv array, never a shell string.** The executable is first, its arguments
follow, and the process is spawned with `shell: false`. Nothing from a tool argument, a tool result
or a model turn is ever interpolated into something a shell parses — that is the whole reason the
key is an array.

A hook receives one JSON document on stdin and answers with its exit code:

- **`pre_tool_call` non-zero blocks the call.** The tail of its stderr (2000 characters, redacted)
  becomes the reason the seat and the user see. A hook past its `timeout_ms` (default 5000ms) is
  killed and counted as a failure, so a hung hook blocks rather than hanging the run.
- **`post_tool_call` never blocks.** Its exit code is recorded. The call has already run, and a
  transcript that claimed otherwise would be a lie.
- **Session hooks are advisory** in the same way, and neither can stop a session opening or closing.

The document is `{ hook, version, adapter, tool, arguments, run_id, step_id, seat }`, plus
`result: { status, summary }` for a post hook and `session_id` for a session hook. **Every string in
it, keys included, goes through the repository's one redactor** (`telemetry/redact.ts`, the same
definition the OTel exporter and the session export use), so a `terminal` command carrying an
`Authorization` header reaches the hook with the credential replaced. Redaction walks the structure
rather than the serialised text, so a placeholder can never break the JSON a hook is about to parse.
`match.tool` limits a hook to one tool name; omitted, it sees every call.

### Hook consent

A hook is arbitrary code a config file asks Trent to run, and a config file arrives by many routes.
So a hook runs only after `trent hooks consent`, which records a SHA-256 hash of the exact spec —
argv, timeout and match filter, scoped by hook kind — in `<profileDir>/hooks-consent.json`, mode
0600. The file holds hashes only, never the commands.

- An unconsented hook **never runs**, and the run reports it once (`TrentToolBuild.hookNotices`),
  not once per tool call.
- **Editing a hook loses its consent.** Change the argv, the timeout or the match filter and it
  goes silent until the user grants it again. A hooks feature where an edited command keeps running
  is a feature that lets anything able to write `config.yaml` run anything at all.
- `trent hooks consent` **replaces** the record rather than adding to it, so removing a hook from
  the config and re-running it revokes the old consent.
- `trent hooks list` shows every configured hook, its argv, its filters and its consent state.
- Consent is checked per hook per call, not once at start-up, so a spec edited mid-run goes quiet
  immediately.

Nothing in the `hooks` command group executes a hook. Granting consent is a decision about future
runs; a command that ran the hook to "check it" would be the one command in the group that needed
consent itself.

Pre and post tool hooks are wired at the dispatch seam in `tools/index.ts` `buildTrentTools`.
Session hooks are `runSessionHooks(kind, context)` from `@trent/core/hooks`; the owner of
`apps/cli/src/runtime/headless.ts` calls it once the session id exists and once in the shutdown
path. Tested in `hooks/consent.test.ts`, `hooks/runner.test.ts` and
`apps/cli/src/commands/__tests__/hooks.test.ts`.

## Policy rules

A single tool call is rarely the problem; the sequence is. Read a secret, then send a message.
Fetch a web page, then run the command it suggested. `packages/trent-core/src/governance/policy-rules.ts`
classifies every tool call and `policy-dispatch.ts` evaluates a rule list against the run's recent
history at the same dispatch point as idempotency, wrapped outside it, so a denied call never
reaches the idempotency store or the adapter.

Classes come from the tool name (else the adapter name, else its scope list) using the app's MCP
policy vocabulary: `read_only`, `write`, `execute`, `external_send`, `network`, `secret_access`,
`destructive`, `money_moving`, `deploy`, `customer_facing`, `inbound`. The arguments add two: a path or value
that looks like a secret (`.env`, `id_rsa`, `*.pem`, `secrets`, `credentials`, tokens, passwords)
adds `secret_access`; a command the approval floor would call destructive (`rm -rf`, `DROP TABLE`,
`git push --force`, `git reset --hard`, any hardline hit) adds `destructive`.

A rule is `{ id, effect, when, also?, after?, within?, reason }`: `when` is the class of the call
being made, `also` a second class it must carry, `after` a class that must appear within the last
`within` calls (default 20) of the same run. The history is a ring per run id, taken from the tool
call context the orchestrator enters around each step; outside a seat turn, a process-wide ring
covers the REPL. The request is what is recorded, not the outcome: a `read_file` of `.env` that
file_ops refuses still counts, because the intent to send what was just asked for is exactly what
the rules watch.

The shipped defaults:

| id | effect | rule |
|---|---|---|
| `send-after-secret` | deny | `external_send` within 20 calls of `secret_access` |
| `network-after-secret` | require_approval | `network` within 20 calls of `secret_access` |
| `destructive-after-network` | require_approval | `destructive` within 20 calls of `network` |
| `execute-after-network` | require_approval | `execute` within 5 calls of `network` |
| `money-needs-approval` | require_approval | every `money_moving` call |
| `no-secret-writes` | deny | `write` that is also `secret_access` |
| `send-after-untrusted` | require_approval | `external_send` within 20 calls of `inbound` (see "Side-effecting tools: the gate") |

`deny` returns a `blocked` tool result naming the rule id and reason, exactly like the hardline
floor: the seat sees why, the run continues, and an approval granted earlier does not lift it.
`require_approval` goes through the app's own gate: the wrapped adapter's `requiresApproval`
answers true and its `dryRun` returns the `needs_approval` record naming the rule; the guardrail
executor calls `execute` only after a human has said yes. Deny beats require_approval when both
match. `policy.rules` in `config.yaml` appends rules; a rule with a default's id replaces it, so
`send-after-secret` can be softened to `require_approval` or the window changed, and a rule with an
unknown class fails config validation. Tested in `policy-rules.test.ts` and `policy-dispatch.test.ts`.

## Skill installation

Every skill is scanned before it loads. See [skills.md](skills.md).

## Workspace instruction files

A repository's `AGENTS.md`, `CLAUDE.md` and `.trent/*.md` are text Trent did not write, so they pass
the same prompt-injection scanner a stored cron prompt passes
(`packages/trent-core/src/tools/cron/prompt-scan.ts`) before any of them reaches a prompt: a flagged
file is refused by name and by scan category, never by quoting what it matched, while the other
files still load, and `trent workspace status` lists the refusal. Two rules stand in front of the
scan: the workspace is untrusted until `trent workspace trust` records it in
`<profile>/workspace-trust.json` (mode 0600), and nothing outside the git root or the working
directory is read, so a symlink pointing out of the workspace is refused instead of followed. See
[configuration.md](configuration.md), "Workspace context files".

## Provenance and untrusted context

The scanners above stop a file Trent reads from becoming an instruction. They do nothing about the
second half of the same problem: what a seat does with text it read at run time, out of a web page,
an MCP server, a plugin, or a child it delegated to. Every tool result therefore carries a
provenance tag — `trusted` or `untrusted` — set in one place, the wrapper chain that builds the
toolsets (`packages/trent-core/src/governance/provenance.ts`). `untrusted` is the `web`, `browser`,
`mcp` and `plugins` toolsets, and any delegated child whose own calls were untrusted: a child's
summary of a page is not cleaner than the page, which is the trust-escalation failure the research
names. The tag accumulates per step, travels on the step's tool-call records, and is rendered as an
`[untrusted]` marker when another seat recalls that step's output a run later, under one line saying
those lines are data and never instructions.

The tag then gates two writes, because the danger is not the reading but what outlives the session.
A `memory` write made in a step that read untrusted output is held as a pending approval row on the
durable approval path rather than written, naming the tools it came from; approving it writes the
entry with `[provenance: untrusted via <tools>]` in the entry itself, so the block says where the
line came from for as long as it exists. `skill_manage` from such a step is refused outright, with
the reason named, because a skill is executable content a later seat runs without reading it. Both
are configurable — `provenance.untrusted_writes` (`hold`, the default, `deny` or `allow`) and
`provenance.untrusted_skills` (`deny`, the default, or `allow`) — and `allow` deliberately reopens
the memory-poisoning path, so it is a choice and not an accident. Nothing here inspects the
untrusted text for an instruction: that detection is unsolved, and the gate is on the combination of
untrusted input and a durable write instead. A held write is decided on either surface — `trent
approvals list` and `/approvals` show each one's kind, the seat that made it and the untrusted tools
it came from, `approve <id>` replays the seat's own action with the provenance recorded in the
entry, and `reject <id>` discards it, leaving the denied row behind as the record of the refusal.

The hold also covers the fleet-memory hook's own `memory`, `fleet_search` and `brain_read` adapters in both
modes: they are registered outside the toolset chain, so `packages/trent-core/src/tools/memory/gate.ts` wraps
them with the very provenance ledger the chain writes to (a fleet run from `orchestrator/index.ts`, solo from
the runtime), because taint is kept per ledger and a gate with a ledger of its own would never see the page.
`apps/cli/src/runtime/headless.memory-gate.test.ts` proves it for a fleet run through the real runtime, tool
chain and orchestrator (`web_extract` then `memory add` in one step returns `needs_approval`, files one pending
row in `gateway.json`, leaves `MEMORY.md` byte-identical, and approving the row writes the entry tagged
`[provenance: untrusted via web_extract]`); `apps/cli/src/runtime/solo-continuity.test.ts` proves the same for
solo.

## Side-effecting tools: the gate

A tool that posts, sends, books, invoices or charges is different in kind from one that writes a
file: what it does leaves the machine and cannot be rolled back. Before this gate existed, the
levels above did not cover it. `autonomy: never` lifted an adapter's own approval
(`governance/autonomy.ts`), one approval covered the rest of a step
(`apps/web/lib/seat-agent-loop.ts:209`; a step that once held an approval re-runs with it,
`orchestrator-run-phases.ts:253`), `publish`, `post`, `book`, `invoice` and `charge` were not
idempotency words, the provenance tag knew nothing of an inbox, and the spend ledger held model
spend only. Five mechanisms close those holes, all applied in the one wrapper chain
`buildTrentTools` builds (`packages/trent-core/src/tools/index.ts`), so a market toolset registered
there is gated before it exists. Nothing is switchable off.

**The three classes.** A call the policy classifier (`governance/policy-rules.ts` `classifyCall`)
marks `external_send` (send, email, message, post, publish, notify, reply, sms), `money_moving`
(charge, refund, payment, payout, transfer, invoice, pay, stripe, checkout, billing) or
`customer_facing` (customer, contact, lead, crm, ticket, book, booking, appointment, reservation)
is on the class floor, unless it is a pure read: `get_contact` is a read, `update_contact` is not.
The floor asks a human at every autonomy level; `never` cannot lift it, a hardline hit or an
`approvals.deny` glob still refuses it outright, and `gate.ask_classes` in `config.yaml` can add a
class (`deploy`, say) but no key removes one (`governance/gate-config-schema.ts`).

**The binding rule.** The approval for such a call is bound to the call's idempotency key,
`{runId, stepId, tool, args}` (`governance/IdempotencyManager.ts` `toolCallKey`), and is stored as
a pending row in `<profile>/gateway.json` carrying a preview of exactly what would be sent — the
adapter's own rendering when it declares `preview(action)`, the arguments as written otherwise
(`governance/bound-approvals.ts`). A yes to call A does not approve call B in the same step, a
changed argument is a different approval, and a reordered argument is not. The check runs inside
`execute`, so the loop-wide grant the seat loop holds after one yes reaches no call whose key a
human has not seen. At the pause the wrapper's `dryRun` stores the preview and stamps the row;
the replay of that exact call inside the same seat turn is the one implicit grant, recorded on the
row as `decidedBy: step approval` (a no fails the step, and a failed step never runs again under
its id). Outside a seat turn nothing is implicit: the call is parked, its summary names the row,
and `trent approvals approve <id>` or `reject <id>` decides it — no new command, the same rows
`trent approvals list` already shows. A new adapter calls
`requireBoundApproval(call, preview)` inside `execute` with the exact content or amount before it
sends anything, and returns the record it is handed when the answer is not granted; an adapter
that forgets is still gated by the wrapper, and an adapter that calls it is gated even when built
outside the chain. The store is installed per process by `buildTrentTools`
(`installBoundApprovals`); with none installed the helper refuses and says so.

**The tokens.** `SIDE_EFFECT_SCOPE_TOKENS` (`governance/idempotent-dispatch.ts`) carries
`publish`, `post`, `reply`, `book`, `invoice`, `charge`, `pay`, `sms`, `refund`, `email`, `quote`
and `appointment` beside the original write, patch, execute, send, network, terminal,
process_manage, delegate and cronjob_manage, so a second identical call in one step returns the
first result and nothing is sent twice, whatever `orchestrator.resume` replays. The match is a
substring; a name such as `postgres_query` is keyed too, which only ever collapses two identical
calls into one result.

**The inbound rule.** An inbox, a comment thread, a review feed or an inbound SMS is text somebody
outside this machine wrote. An adapter declares it with the `inbound` scope, or by naming the
tool with the family (`inbox_list`, `inbound_sms`); its results are tagged `untrusted` exactly as
a web page is (`UNTRUSTED_ADAPTERS` gains `inbound`), and the same test adds the `inbound` class to
the call in the policy ring, as it does for the web, browser, MCP and plugin families and for any
result an adapter tagged untrusted itself. The shipped rule `send-after-untrusted`
(`require_approval`, `external_send` within 20 calls of `inbound`) is the mirror of
`send-after-secret`: a post in a step that read a comment asks, and the reason names the call it
read, even when nothing else would have asked. A post with no untrusted read in the step is
gated by the class floor alone. Reads should be named `<family>_list` or `<family>_read`: the
classifier reads `send`, `email`, `message`, `post`, `publish`, `reply` and `sms` as outbound
wherever they appear in a name, so `read_email` would be gated as a send.

**External spend.** A Twilio message, a Buffer post, an image generation or a hosted
transcription is money. An adapter records it with `recordToolSpend({ run_id, tool, provider,
cents })` (`governance/spend-ledger.ts`); the row lands on the same `spend.ndjson` as model spend,
as `surface: "tool"` with the provider, and `dailyTotalCents` — what the REPL's cap check and
`trent budget status` read — counts it. Integer cents; a float throws.

Tested in `governance/autonomy.test.ts`, `autonomy-dispatch.test.ts`, `bound-approvals.test.ts`,
`idempotent-dispatch.test.ts`, `provenance.test.ts`, `policy-rules.test.ts`, `spend-ledger.test.ts`
and, through `buildTrentTools` on fake executors at `autonomy: never`, `gate-chain.test.ts`.

## Auto review

Every call the gate above holds used to wait for a person. `governance.auto_review` lets a second
model decide some of them, the way Claude's auto mode has a classifier review each action and Codex's
auto-review has a reviewer agent decide approvals at the sandbox edge: it changes who reviews, not
what is allowed. It is off by default and it only ever narrows (`governance/auto-review*.ts`).

**What it reviews.** Only a held call bound to its arguments (`details.kind: "bound_call"`, the rows
the class floor parks). A run approval is released the instant it is decided and carries no
arguments to hold against a policy; an `ask_human` question is for you; a held memory write is
untrusted by construction. Those are always left for a person.

**The written policy, checked in code first.** A row is eligible only when every rule passes, and
an ineligible row is escalated with the rule named without any model being built or called
(`auto-review-policy.ts`):

| Rule | Escalates when |
|---|---|
| `untrusted_provenance` | the preview, the action or the arguments carry `[provenance: untrusted` or `[untrusted]` |
| `hardline`, `approval_floor`, `deny_glob` | the hardline blocklist, the approval floor or an `approvals.deny` glob names the call, re-checked on the stored row |
| `never_class` | the call executes, destroys, deploys or touches a secret: no policy makes that approvable |
| `class_above_max` | its tier is above `max_class`; the ladder is `read` < `write` < `external_send` (sends, customer-facing calls, network) < `money` |
| `money_amount_unknown`, `money_currency`, `money_over_cap` | a money call whose integer-cent total cannot be read from its lines, is in another currency than `currency`, or exceeds `max_amount_cents` |
| `recipient_unknown`, `recipient_not_allowed` | a send that names no recipient (a public post, an invoice send naming only the invoice), or any recipient not on `recipients` |

**The reviewer.** An eligible row is put to the model (`governance.auto_review.model` pins it; a
local model is fine when the profile's `provider` is that local runtime, because the pin is sent
through the profile's own provider and a pin it cannot answer fails, leaving the row held) at
temperature 0 with the exact preview, the bound arguments and the policy, and
must reply with exactly `{"decision": "approve"|"deny"|"escalate", "reason": "..."}`. The gateway
request has no response-format field, so the shape is asked for in the prompt and enforced on the
reply: prose, an unknown decision, a missing reason, an extra key or two objects is no verdict. No
verdict — a malformed reply, a failed call, or `escalate` — leaves the row pending, so the call stays
blocked for you. A failed call is asked again on the next pass; everything else is reviewed once.

**Same path as your decision.** Approve and deny go through `ApprovalBridge.decide(id, decision,
"auto-review:<model>")`, the call `trent approvals approve` makes with `human`: the same row fields,
the same `approval_decided` event, the same store mirror where one is wired. The reviewer's own model
spend is charged to the profile's spend ledger as `surface: "auto-review"`.

**The audit chain.** Every reviewer decision, every escalation and every override is one row of
`<profile>/approvals-audit.ndjson` (0600), in the app's `AuditLog` row shape, hashed with the same
formula and linked to the row before it, so the verifier `trent audit verify` uses re-walks it and
names the first edited line. `trent approvals list` shows the rows the reviewer decided with their
actor and reason, and each escalated row with why; `trent approvals list --policy` prints the policy.

**Reversing it.** A bound approval runs nothing by itself: the identical call's replay does, and the
first replay a reviewer's approval grants is stamped on the row (the one `[H1]` line in
`bound-approvals.ts` `require()`). Until then `trent approvals reject <id>` reverses it and the replay
is refused; after, the call has run and the reject is refused with the time it ran.
`trent approvals approve <id>` on a row the reviewer denied approves exactly that call. To stop the
reviewer altogether, set `enabled: false`: already-granted approvals stay granted, and the chain
records every one.

**When it runs, and what it never decides.** `trent approvals list --review` runs one pass; while
`enabled` is true, so does each tick of `trent service daemon` (its `auto-review` component, every
60 seconds) and of the heartbeat `trent gateway start` carries, all through `reviewHeldApprovals`.
A held row is stamped `untrusted_inbound: true` when its run read text written outside this machine
(a run a signed webhook started, or an `inbound` entry in a ring the row writer sees: a solo
conversation's, or a dispatcher ring handed to `createBoundApprovalStore`), and the reviewer escalates
it under `untrusted_provenance` with no model asked, whatever the policy says. Not stamped yet: a
fleet run that read an inbox or a page without a webhook, because the tool build does not hand its
ring to the row writer; there the recipient allowlist and the money cap bound the send, and
`send-after-untrusted` still pauses its step. Inside a seat turn the step still pauses for a person
(`seat-agent-loop.ts:209`); a reviewer's deny on the bound row blocks the call even after the step is
approved. Tests: `governance/untrusted-inbound.test.ts`, `heartbeat/auto-review-tick.test.ts`.

Tested in `governance/auto-review-policy.test.ts` (each rule), `governance/auto-review.test.ts` (the
reviewer against a fake model: approve, deny, escalate, malformed, absent; the chain; reversal; and
that with the switch off nothing changes) and `apps/cli/src/commands/__tests__/approvals.test.ts`.

## Auditing a profile

Everything above is spread over `config.yaml`, four records beside it and two directories, so in
practice nobody reads all of it before trusting a profile. `trent security audit` does it in one
read-only pass:

```sh
trent security audit                 # human report; exit 0 clean, exit 1 with findings
trent security audit --json          # the same report, parseable
trent security audit /path/to/repo   # check that directory's workspace trust instead of the cwd
trent security audit --audit-export trent-audit-2026-09-18.ndjson
```

It writes nothing — no key is generated, no consent is recorded, no mode is changed — so it is safe
to run unattended, and the exit code is what a CI job gates on.

| Section | What it reads | What it can find |
|---|---|---|
| `autonomy` | `autonomy` | `autonomy-never`: the level auto-approves what the floors would have asked about |
| `approvals` | `approvals.deny`, `governance/hardline.ts` | nothing; it reports the glob list, the rule count and a sha256 over the shipped rules' ids and reasons, so a changed blocklist is visible between two runs |
| `hooks` | `hooks`, `<profile>/hooks-consent.json` | `hook-not-consented`: a hook is configured whose exact spec is not in the record, so it silently never runs |
| `egress` | `egress`, `terminal.backend` | `egress-proxy-disabled`, `sandbox-backend-local` |
| `workspace` | `<profile>/workspace-trust.json` for the given directory | `workspace-changed-since-trusted` |
| `redaction` | `privacy.redact_prompts`, `privacy.patterns` | nothing; the detector names are listed so you can see what redaction would and would not catch |
| `mcp` | `mcp_servers` | `mcp-server-flagged-tools`, `mcp-server-unscanned`. Result scrubbing is reported by running `scrubMcpResult` over a probe string, not by asserting it |
| `plugins` | `<profile>/plugins/*/plugin.json` | `plugin-manifest-refused`, with the loader's own reason |
| `audit-chain` | `<profile>/keys/audit.pub`, and `--audit-export` when given | `audit-export-unverified`, from the same `verifyAuditExport` that `trent audit verify` calls |
| `file-permissions` | every file under the profile directory | `profile-file-too-permissive`: `.env`, `hooks-consent.json`, `workspace-trust.json`, `keys/`, `sessions/`, `egress/ca.key`, `egress/tokens.json` and the store must grant nothing to group or other |
| `config-secrets` | `config.yaml` | `secret-in-config-yaml`: a credential-shaped value in a file written 0644 |

Every finding carries a severity (`critical`, `high`, `medium`, `low`) and a fix line, and the
report exits 1 if there is even one. Two things it deliberately does not do. It never prints a
secret: the `config-secrets` section names the KEY and the line number and never the value, because
a security report is exactly the file someone pastes into a chat window. And it asserts nothing —
the hardline count comes from `HARDLINE_RULES`, "this level lifts no floor" is `autonomyVerdict`
being asked with a hardline hit, a deny hit and a floor in turn, and the permission section stats
the real files. A report that shipped its own answers would pass its tests forever and tell you
nothing about your machine.

Two detectors are left out of the `config-secrets` scan on purpose: the 40-character alphanumeric
sweep, which matches every git SHA and content hash, and any value that is exactly a `${VAR}`
reference, which is resolved at connect time and never stored. Both would cry wolf often enough to
teach a reader to skip the section.

`packages/trent-core/src/governance/security-audit.ts`, tested in `security-audit.test.ts` and
`apps/cli/src/commands/__tests__/security.test.ts`.

## Reported, not fixed: defects in the wrapped application

`apps/web/` is read-only in this repository. These are real and they are outside the CLI's scope.

1. `apps/web/lib/session.ts:51` returns `true` when `DATABASE_URL` is unset, so a production deploy
   with a missing or misnamed database URL grants every authenticated user access to every company.
   The same pattern appears at `:65` and `:88`, and `with-rls.ts:21` decides at module load.
   `apps/web/CLAUDE.md:65` misdescribes this as an `NODE_ENV=development` bypass; `NODE_ENV` is never
   read.
2. `apps/web/lib/rate-limit.ts:21` returns ok on Redis absence, before the try block, so
   `checkAuthRateLimit` fails open. The documentation says it fails closed.
3. `apps/web/lib/heartbeat.ts:335-336` builds fresh in-memory stores, so the production
   self-improvement sweep reads an empty trace store and is a no-op.
4. Four modules call `appendAuditLog` directly and throw when `DATABASE_URL` is unset.

## Not yet implemented

- A signed release, cut. The installer, `trent update` and `trent desktop install` verify
  `SHA256SUMS` against embedded Ed25519 (minisign) and ECDSA P-256 public keys and refuse unsigned
  artefacts. `.github/workflows/release.yml` signs `SHA256SUMS` with the `TRENT_MINISIGN_KEY` and
  `TRENT_ECDSA_KEY` repository secrets (on disk only inside the signing step, under `umask 077`,
  shredded after) and verifies both signatures against the committed public keys before
  `gh release create`; but no tag has been pushed, so no release exists, and the repository is
  private, so the release URLs the installer uses would 404 for the public anyway
  (`05_release/output/release-runbook.md`).
- Automatic CA injection into a running container. The certificate path and the environment are
  built; wiring the mount into every backend is not finished.
