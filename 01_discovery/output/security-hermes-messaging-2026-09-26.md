# Hermes v0.21.3 messaging-surface security review (D2-original)

Source-only review of `~/.hermes/hermes-agent` (upstream 49eb7b5d). No Hermes run, no credential
file opened; files under `~/.hermes` checked with `stat` only. `file:line` under the Hermes tree.
CONFIRMED = traced end to end; SUSPECTED = real path, exploit depends on something outside the code.
Complements `security-hermes-platform-2026-09-26.md` (D2-relaunch) and `security-hermes-exec-2026-09-26.md` (D1).

## Critical
- **C1 Email sender spoofing via From-parser mismatch (CONFIRMED).** `plugins/platforms/email/adapter.py:244-247`
  reads the sender as the first `<...>` in the raw `From:`, so `From: "<owner@gmail.com>" <x@evil.example>`
  is read as owner while MTAs check evil.example. `:281-282` accepts `dmarc=pass` without matching its
  `header.from` to the parsed address -> attacker's own-domain DMARC pass clears `_sender_accepted` (:621),
  becomes owner `user_id` (:645), full `hermes-email` toolset incl. terminal (`toolsets.py:216`).
- **C2 DKIM alignment reads the wrong field (CONFIRMED logic).** `adapter.py:58,287-290` falls back to
  `header.from` when no `header.d`; `dkim=pass header.i=@evil; dmarc=fail header.from=gmail.com` counts as
  aligned for a spoofed @gmail.com (p=none). `authserv_id` empty by default (:363): an injected
  Authentication-Results header is trusted if the provider adds none.
- **C3 SimpleX self-chosen identity (CONFIRMED).** `gateway/authz_mixin.py:175-176` checks the sender
  display name against the allowlist; documented entries are small sequential contact IDs
  (`plugins/platforms/simplex/adapter.py:4-5`); requests auto-accepted (:99-104). Set display name "3" -> match.

## High
- **H1 WhatsApp bridge unauthenticated (CONFIRMED).** `scripts/whatsapp-bridge/bridge.js:795-826,1151`
  listens 127.0.0.1:3000, Host-header check only; `/messages` (:829) reads the queue, `/send-media` (:909-924)
  reads any file via arbitrary `filePath`. Hermes adopts whatever answers `/health` with a public-file hash
  (`plugins/platforms/whatsapp/adapter.py:356-372,212-218`) -> local port-squat injects owner-authorized msgs.
- **H2 Admin slash-commands open by default (CONFIRMED).** Gating off unless admin list set
  (`gateway/slash_access.py:39-41,93`): `/approvals off`, `/yolo`, `/approve always`, `/update`, `/restart`,
  `/sethome`, `/reload-mcp` reachable; `/debug` uploads log content to a public paste site with no confirm
  (`slash_commands.py:1216-1240`, `hermes_cli/debug.py:100-110`). Thread sessions shared (`gateway/session.py:692`)
  -> any thread member approves another's dangerous command.
- **H3 Home Assistant events always authorized, full toolset (CONFIRMED path).** `authz_mixin.py:634` +
  `toolsets.py:212`; entity/state text -> prompt (`plugins/platforms/homeassistant/adapter.py:250-264`) ->
  injection path to terminal via any influenced entity (e.g. a "last notification" sensor).
- **H4 Local A2A unauthenticated and gateway-trusted (CONFIRMED auth path).** No tokens -> every loopback
  caller authenticated (`plugins/platforms/a2a/security.py:88-89,103-106`); `authorization_is_upstream=True`
  (`adapter.py:307-314`) skips the gateway check (`authz_mixin.py:539-543`).

## Medium
- Webhook replay: GitHub/Linear sigs cover body only (`webhook.py:719-723`), V1 sigs still accepted (:740-748),
  dup-ID from unsigned headers (:614-617) -> captured delivery replays forever. Feishu: sig timestamp never
  checked (`feishu/adapter.py:2850-2861`), token-only allowed (:2799,:1499).
- Webhook->cron escapes the safe toolset: cron_job routes run payload text under the cron toolset (terminal by
  default), bypassing the webhook safe list (`webhook.py:505-521` -> `cron/scheduler.py:2262,1376`).
- "@" allowlist rule applies to every platform (`authz_mixin.py:162-163`) + global `GATEWAY_ALLOWED_USERS`
  (:690-697): `123456789@attacker.tld` matches a numeric Telegram ID/phone on the list.
- Relay trusted without verification: plain `ws://` accepted (`relay/ws_transport.py:91-92`), inbound always
  trusted (:214) bypassing allowlist, `verify_delivery_signature` never called (`relay/auth.py:85`), `exp=0`
  tokens never expire (:135).
- Matrix keys shared at UNVERIFIED trust (`matrix/adapter.py:1231-1232`). IRC identity = nickname only,
  NickServ password sent to whoever holds the nick (`irc/adapter.py:309,314,183-184`).
- Loose opt-ins: `SMS_INSECURE_NO_SIGNATURE=true` no loopback guard (`sms/adapter.py:108-128`); SMS From
  carrier-spoofable (SUSPECTED); `*_ALLOW_BOTS=mentions` admits any bot incl. Discord webhook relays
  (`authz_mixin.py:559-567`); a Discord allowed-channels list alone admits every channel member.

## Low / weak defaults
- BlueBubbles: non-constant-time webhook password compare (`gateway/platforms/bluebubbles.py:565`); password in
  URL query (:138,262-270); schemeless server URL sent over http (:84-85).
- Pairing-slot DoS: 3 identities fill the per-platform pending cap for an hour (`gateway/pairing.py:35,443`).
- First-contact notices have no global rate limit (`run_inbound_unauthorized.py:92-104`).
- `hermes pairing list` prints attacker-supplied names raw (`hermes_cli/pairing.py:37`) (SUSPECTED terminal escape).
- Google Chat `/setup-files` runs before authorization (`google_chat/adapter.py:877-881`): leaks token path, can
  revoke the shared legacy token. Teams/BlueBubbles/Google Chat/SimpleX download attachments before sender check.
- Wide default binds: webhook, MS Graph, WhatsApp Cloud listeners default to all interfaces
  (`webhook.py:56`, `msgraph_webhook.py:34`).

## What is solid (Trent must not regress below)
Pairing codes 8 chars / 32-symbol alphabet, 1 h expiry, salted SHA-256, constant-time, lockout. API server
loopback default, key >= 16 chars, constant-time. Control socket umask 0177 / 0600. Default-deny with no
allowlist. Discord role checks scoped to one server. Matrix invites only from authorized users. Signatures
required for Twilio SMS, WhatsApp Cloud, LINE. Telegram webhook requires its secret.

## Permissions under ~/.hermes (stat only, no contents read)
`~/.hermes` 0700; `auth.json`/`.env`/`config.yaml`/`state.db`/`gateway.sock` 0600. World-readable (0644) but
shielded by the 0700 parent: `logs/*` (message content), a `state.db.pre-update-emergency-*.bak`, `kanban.db`,
`shared-state.db`, `projects.db`, `.hermes_history`, a config backup. `state/gateway.loop-tick.*.sock` 0755.
Risk realizes only if HERMES_HOME moves to a 0755-parent volume.

## Not covered
Web dashboard auth (`web_server.py`, `dashboard_auth`), DingTalk/WeCom/Weixin/Yuanbao/QQ internals, hosted
rooms, Teams JWT validation.
