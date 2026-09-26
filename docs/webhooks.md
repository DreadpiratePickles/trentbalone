# Webhook routes

A webhook route lets something outside a chat start the agent: a Stripe event, a GitHub issue, a
form post, a local script. Each route is a signed HTTP path on the gateway's webhook listener. A
delivery that passes the signature starts one run, and the sender gets `202` with the run id.

Code: `packages/trent-core/src/webhooks/` (engine, signatures, templates, delivery store), mounted
on `packages/trent-core/src/gateway/WebhookServer.ts`. Config: `gateway.webhooks` in
`packages/trent-core/src/config/sections/gateway.ts`.

## Configure a route

```yaml
gateway:
  webhooks:
    host: 127.0.0.1            # the listener; loopback by default
    port: 8644
    routes:
      - name: stripe-paid
        path: /hooks/stripe
        signature: stripe          # hmac-sha256-ts | hmac-sha256 | stripe | github | none-localhost-only
        secret_env: STRIPE_WEBHOOK_SECRET   # the NAME of the variable holding the secret
        objective_template: "Invoice {{payload.data.object.id}} for {{payload.data.object.customer_email}} was paid. Send the receipt."
        dedupe_key: "{{payload.id}}"
        events: [invoice.paid]
        mode: fleet                # fleet | solo
        seat: finance-ops
        max_cost_cents: 50
        rate_per_minute: 30
```

Put the secret in the environment or the profile's secrets file under that name. Config holds
the name only, and the schema refuses anything that does not look like a variable name, so a
pasted `whsec_...` value is rejected rather than stored.

`trent gateway start` serves the routes on `host:port` under the profile's gateway lock. The routes
alone keep the gateway up when no chat platform is configured. `trent gateway status` lists the
routes and the last five deliveries.

The listener binds loopback. To take deliveries from Stripe or GitHub, put a tunnel or a reverse
proxy in front of it ([A tunnel in front of the listener](#a-tunnel-in-front-of-the-listener)).
The same listener also serves the chat adapters' `/webhooks/<platform>` paths, so a route path
may not start with `/webhooks/`. Use `/hooks/<name>`.

## Order of checks

1. The path must name a route. Otherwise it falls through to the chat adapters, which answer `404`.
2. `POST` only (`405`). A body over 1 MiB gets `413`.
3. **The signature, over the raw body, before anything is parsed** (`401`). Compared with
   `crypto.timingSafeEqual` after the offered value is checked to be a full 64-hex digest.
   - `github`: `X-Hub-Signature-256: sha256=<hex>`.
   - `stripe`: `Stripe-Signature: t=<unix>,v1=<hex>` over `<t>.<body>`. `t` must be within
     `tolerance_seconds` (default 300) of this host's clock, in either direction. Any one `v1` may
     match, so a secret being rolled keeps working.
   - `hmac-sha256-ts`: `[sha256=]<hex>` in `signature_header` (default `x-webhook-signature`) over
     `<t>.<body>`, where `t` is unix seconds in `timestamp_header` (default `x-trent-timestamp`), or
     both ride the signature header as `t=<unix>,v1=<hex>`. `t` must be within `tolerance_seconds`
     (default 300) of this host's clock, in either direction, so a captured delivery is dead once
     that has passed, and inside it the dedupe below answers the copy. Prefer it to `hmac-sha256`.
   - `hmac-sha256`: `[sha256=]<hex>` in `signature_header` (default `x-webhook-signature`), over the
     body alone. Nothing dates it, so a captured delivery can be replayed once the 24 h dedupe has
     passed.
   - `none-localhost-only`: no secret. The peer must be loopback and so must the listener's own
     address (`403` otherwise), and the schema refuses such a route when `host` is not loopback.
     A page in your browser posts from loopback too, so the route also answers `403` to a request
     carrying an `Origin` header (a browser sends one on every cross-site POST, `null` included),
     to one carrying a forwarding header (see the tunnel section), and to a body that is not
     `content-type: application/json` and valid JSON. A form or a no-cors fetch cannot send
     `application/json` without a CORS preflight, and the preflight gets `405`. A local script
     sends `-H 'content-type: application/json'` and no `Origin`.
   A signed route whose variable is unset gets `503`, naming the variable and never a value.
4. The body must be JSON (`400`; `403` on a `none-localhost-only` route).
5. `events`: an event the route does not list gets `200` and is ignored. The event name is
   `X-GitHub-Event` for `github` and the payload's `type` otherwise.
6. **Dedupe.** The key is `dedupe_key` rendered from the payload. If that is unset or renders
   empty, the key is the body's SHA-256. The same key within 24 hours gets `200` with the original
   run id and never starts a second run. This holds across a gateway restart because the index is
   rebuilt from the delivery store. Two copies arriving together also start one run. A delivery
   whose run never produced a frame releases its key, so the sender's retry can start it.
7. `rate_per_minute` per route (`429` with `Retry-After`). A replay is answered before this check,
   so a retried delivery is never rate-limited into a second attempt.
8. The run starts through the runner of the route's `mode` and the answer is `202` with its id.
   If the run has not produced its first frame within 10 s, the answer is `202` with `run_id: null`
   and the store records the id when it arrives.

## What the run receives

The objective is `objective_template` with `{{payload.a.b}}` filled in from the JSON body. Only
`payload` paths are allowed, and the schema refuses anything else, including prototype segments.
Paths walk own properties and array indexes. A missing value renders as nothing. An object renders
as JSON. Each value is clipped to 2000 characters.

The payload was written outside this machine, so the run is tagged the same way a business read's
record is:
- The first message opens with `[provenance: untrusted via webhook:<route>]` and a line telling
  the agent to treat filled-in values as data, never as instructions.
- The run input carries `provenance: "untrusted"` and `inbound: "webhook:<route>"`.
- A surface that hands the engine its `PolicyDispatcher` (`seedInbound`, using
  `seedInboundTaint`) gets the run's policy ring seeded with one `inbound` read on the run's first
  frame, before another frame is read. `send-after-untrusted` then asks before any send in that
  run, as it would after an inbox read. If the seed fails, the run is stopped.

External sends ask a human at every autonomy level anyway (the class floor in
`governance/gate-config-schema.ts`).

`max_cost_cents` is handed to the runner. The engine also enforces it: it sums the metered frames
(`step_end` and `consolidate_end` `costCents`, the same frames the spend ledger charges) and aborts
the run when they reach the cap. The run's end is then recorded as `cost_cap`. `seat` is named in
the objective and handed to the runner.

## The delivery store

`<profile>/webhooks/deliveries.jsonl` (0600, directory 0700) has one row per delivery answered and
one per run ended: `at`, `delivery`, `route`, `verdict`, `status`, `key`, `run_id`, `mode` and a
short `detail`. It never holds the secret or the body. The only values it takes from the payload
are the dedupe key and, on an `ignored` row, the event name; from the headers, only a
`browser_origin` row's `Origin`, clipped to 100 characters. The verdicts are `started`, `replay`,
`ignored`, `bad_signature`, `not_loopback`, `browser_origin`, `not_json`, `no_secret`,
`rate_limited`, `bad_body`, `too_large`, `method`, `no_runner`, `run_error`, and for a run's end
`completed`, `failed`, `cancelled`, `input-required` and `cost_cap`. Rows older than 24 hours are
dropped when the store opens, but the most recent 200 rows are always kept.

## A tunnel in front of the listener

The listener binds loopback, so a sender on the internet reaches it through a tunnel that runs on
this machine. Cloudflare's quick tunnel needs no account:

```sh
trent gateway start                               # the listener, on gateway.webhooks host:port
cloudflared tunnel --url http://127.0.0.1:8644    # prints https://<name>.trycloudflare.com
```

Give the sender `https://<name>.trycloudflare.com/hooks/<route>`, or for a chat adapter
`.../webhooks/<platform>` (LINE: `/webhooks/line`). A quick tunnel gets a new name each time it
starts, so a sender you configure once needs a named tunnel on your own Cloudflare domain, which
this page does not cover.

What the tunnel changes:
- It forwards every path on the listener: every route and every chat adapter's path. Keep only
  signed routes behind it. Trent checks the signatures; the tunnel checks nothing.
- The tunnel's connector reaches the listener from `127.0.0.1`, so to the loopback rule it looks
  local. A `none-localhost-only` route therefore answers `403` to a request carrying `Forwarded`,
  `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP` or `True-Client-IP` (cloudflared adds
  `X-Forwarded-For` and `CF-Connecting-IP`). A raw TCP forward that adds no header, such as
  `ssh -R` with no web server in front of it, cannot be told from a local script: do not keep a
  `none-localhost-only` route on a listener that is forwarded that way.

A route and a test sender for `hmac-sha256-ts`. The secret is shared with the sender and lives
only in the variable named by `secret_env`:

```yaml
      - name: acme
        path: /hooks/acme
        signature: hmac-sha256-ts
        secret_env: ACME_WEBHOOK_SECRET
        objective_template: "Acme order {{payload.id}} was paid."
        dedupe_key: "{{payload.id}}"
```

```sh
BASE=https://<name>.trycloudflare.com
BODY='{"id":"evt_1","type":"order.paid"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$ACME_WEBHOOK_SECRET" | sed 's/^.* //')
curl -sS -X POST "$BASE/hooks/acme" -H 'content-type: application/json' \
  -H "x-trent-timestamp: $TS" -H "x-webhook-signature: sha256=$SIG" --data "$BODY"
```

The answer is `202` with a run id. The same request again is `200` with the same run id. Signed
with another secret, or sent more than 300 s after `TS`, it is `401`. The inline form sends
`-H "x-webhook-signature: t=$TS,v1=$SIG"` and no timestamp header.

What has been run (2026-09-26, `docs/sessions/2026-09-26-c8-webhook-hardening.md`): cloudflared
is not installed on the machine this was written on, so the tunnel itself has not been run. A
local Node proxy on `127.0.0.1:8645` stood in for its connector: it forwards to `127.0.0.1:8644`
and adds `X-Forwarded-For` and `CF-Connecting-IP`. Behind it was the real listener
(`openWebhookRoutes`, the call `trent gateway start` makes) with a runner that reaches no model.
With `BASE=http://127.0.0.1:8645`, the commands above answered `202`, the repeat `200`, a forged
signature `401`, a delivery signed 301 s earlier `401`, the inline form `202`, and a POST to a
`none-localhost-only` route through the proxy `403`.

## Not yet implemented

- **A route whose `mode` differs from the gateway's own `agent.mode`.** `trent gateway start`
  builds one runtime, and it exposes the runner for its own mode only. A route on the other mode
  gets `503` naming the mode. The engine takes a runner per mode (`runnerFor`), so it needs no
  change when the runtime exposes both.
- **Seeding the policy ring from `trent gateway start`.** The headless runtime does not expose the
  `PolicyDispatcher` its tools were wrapped with, so the CLI passes no `seedInbound`. Runs started
  there carry the first-message marker and the `provenance` field but not the ring entry. The
  engine, `seedInboundTaint` and its test (`webhooks/engine.test.ts`, "a seeded ring makes
  send-after-untrusted ask") are in place for when it does.
