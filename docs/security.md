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

Approval floors are matched over deobfuscated command variants:
`packages/trent-core/src/tools/approval-floors.ts` (`floorBlock`, `dangerous`, `detectionVariants`)
runs every rule in `approval-patterns.ts` (`HARDLINE_PATTERNS`, `DANGEROUS_PATTERNS`, ported from
Hermes `tools/approval_detection.py`) against each variant, so `r\m -rf /`, `rm${IFS}-rf${IFS}/`,
`$(echo rm) -rf ~`, `env rm -rf /` and `sh -c 'rm -rf /'` all reach the same rule; the hardline floor
is checked inside `execute`, not only at `requiresApproval`, so it is never bypassed by an earlier
approval. Tested in `approval-floors.test.ts`.

## Policy rules

A single tool call is rarely the problem; the sequence is. Read a secret, then send a message.
Fetch a web page, then run the command it suggested. `packages/trent-core/src/governance/policy-rules.ts`
classifies every tool call and `policy-dispatch.ts` evaluates a rule list against the run's recent
history at the same dispatch point as idempotency, wrapped outside it, so a denied call never
reaches the idempotency store or the adapter.

Classes come from the tool name (else the adapter name, else its scope list) using the app's MCP
policy vocabulary: `read_only`, `write`, `execute`, `external_send`, `network`, `secret_access`,
`destructive`, `money_moving`, `deploy`, `customer_facing`. The arguments add two: a path or value
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
