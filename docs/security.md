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

Session files were 0644 in a 0755 directory before this was hardened. Every write is now
write-then-rename with the mode re-asserted after the rename, so an interrupted write cannot leave a
world-readable transcript. A directory that cannot be chmodded — a network mount, Windows — still has
to be usable, so that case degrades rather than failing.

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
- Approval floors matched over deobfuscated command variants. The design calls for them; they are not
  built.
- Automatic CA injection into a running container. The certificate path and the environment are
  built; wiring the mount into every backend is not finished.
