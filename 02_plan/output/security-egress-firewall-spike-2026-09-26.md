# Egress L3 firewall spike — measured on this host (2026-09-26)

Spike for SEC-1 / required change 1-2 of `02_plan/output/security-hardening-review-2026-09-26.md`.
Question: replace today's proxy-honour-only egress (egress container on the default `bridge` with
`host.docker.internal:host-gateway`, so `curl --noproxy '*' https://<ip>` escapes the allowlist) with
a topology where the **only reachable L3 destination is the Trent egress proxy**, while the proxy
stays reachable. Everything below was run against Docker on this machine; commands + output are
verbatim (trimmed).

## Platform

```
docker version → Client/Engine 29.5.3, API 1.54; Server: Docker Desktop 4.77.0 (228796)
                 Engine OS/Arch linux/arm64, Go go1.26.4; containerd v2.2.4; runc 1.3.5
docker info    → Name=docker-desktop  OS=Docker Desktop  driver=overlay2
```

This is **Docker Desktop for Mac** (LinuxKit VM, gVisor/vpnkit-style stack). Inside containers the
host is reached over the Docker Desktop VM subnet `192.168.65.0/24`: `host.docker.internal` →
`192.168.65.254`, upstream resolver `host(192.168.65.7)`. That is the key difference from native
Linux, where `host.docker.internal:host-gateway` resolves to the bridge gateway `172.17.0.1`.

## How Trent binds/reaches the proxy today (from source)

- Proxy is a **host process** (`EgressProxy`, Node/Bun). `egress/bind-hosts.ts:54-58`: on macOS it
  binds **loopback only** (`127.0.0.1`); on Linux+docker it also binds the bridge gateway
  (`172.17.0.1`, discovered via `docker network inspect bridge`).
- Egress container: `tools/sandbox.ts:79` joins `DEFAULT_BRIDGE="bridge"`; `:103` adds
  `host.docker.internal:host-gateway`; `apps/cli/src/repl/tools.ts` sets the sandbox proxy URL to
  `http://host.docker.internal:<port>`. On Desktop the VM forwards that alias to host loopback, so a
  `127.0.0.1` listener suffices. **No `--internal`, no per-container firewall** (`DockerBackend.ts:118`
  passes `--network` verbatim; `:119` `--cap-drop=ALL`, `:120` `no-new-privileges`).

## Test 1 — `--internal` network on Docker Desktop

```
docker network create --internal trent-spike-int
  → driver=bridge internal=true subnet=172.22.0.0/16 gw=172.22.0.1   (default bridge: 172.17.0.1/16)

docker run --rm --network trent-spike-int --add-host host.docker.internal:host-gateway alpine:3 …
  resolve host.docker.internal → 192.168.65.254  (STILL injected into /etc/hosts by the VM)
  (a) nc -vz -w3 1.1.1.1 443            → "Network unreachable"        rc=1   [PASS: public blocked]
  (b) nc -vz -w3 host.docker.internal 9099 → "192.168.65.254: Network unreachable" rc=1  [proxy UNREACHABLE]
  (c) nc -vz -w3 172.22.0.2 8000 (peer on same net) → "open"          rc=0   [peer reachable]
```

Verdict: `--internal` **cuts off the proxy** on Docker Desktop. The alias still *resolves* (VM injects
`/etc/hosts`) but does not *route* — `192.168.65.254` is off the `172.22.0.0/16` subnet and dropped.
1.1.1.1 is correctly unreachable; a peer container on the same internal net is reachable (so a shared
internal net allows seat-to-seat lateral movement — needs per-seat networks).

## Test 2 — DNS over UDP on the internal net (exfil channel?)

```
docker run --rm --network trent-spike-int alpine:3 -- nslookup example.com
  resolv.conf: nameserver 127.0.0.11 … ExtServers:[host(192.168.65.7)]
  example.com          → "server can't find example.com: SERVFAIL"
  deadbeef.example.com → "SERVFAIL"
docker run --rm --network trent-spike-int --dns 127.0.0.1 alpine:3 -- nslookup example.com → SERVFAIL
```

Verdict: on `--internal`, the embedded resolver `127.0.0.11` is present but its **upstream
(192.168.65.7) is unroutable**, so every public name returns SERVFAIL. **DNS-over-UDP exfil to
external names is already dead** as a side effect of `--internal` (container-name + `host.docker.internal`
lookups from `/etc/hosts` still work, which is what we want). `--dns 127.0.0.1` changes nothing
observable here (Docker still injects `127.0.0.11`); it is not needed.

## Test 2b — in-container iptables (rejected)

A per-container OUTPUT policy needs `CAP_NET_ADMIN`. Trent runs `--cap-drop=ALL` +
`no-new-privileges` (`DockerBackend.ts:119-120`), so an in-container firewall **cannot be installed**
(and an entrypoint that added caps before dropping them would defeat the hardening). Rejected: the
mechanism must be **network topology**, not in-container rules.

## Test 2c — `gateway_mode` option

```
docker network create -o com.docker.network.bridge.gateway_mode_ipv4=isolated trent-spike-gw
  → "gateway mode 'isolated' can only be used for an internal network"
```

`isolated` requires `--internal` and gives **no external route at all** (not even host-gateway), so it
does not restore proxy reachability. No gateway_mode value makes an internal net reach the host on
Desktop.

## Test 3 — dual-homed forwarder sidecar (the mechanism that works)

Forwarder = a tiny container on the internal net **and** the default bridge, relaying the internal-net
proxy port to the host proxy.

```
docker run -d --name trent-spike-fwd --network trent-spike-int \
    --add-host host.docker.internal:host-gateway trent-sandbox:1 sleep-loop
docker network connect bridge trent-spike-fwd
  → int=172.22.0.3  bridge=172.17.0.2
# forwarder reaches host proxy over its BRIDGE leg:
docker exec trent-spike-fwd python3 -c 'socket.create_connection(("host.docker.internal",9099),3)'
  → CONNECTED to host proxy
# forwarder runs a TCP relay 0.0.0.0:8888 → host.docker.internal:9099
# sandbox joins ONLY the internal net, host.docker.internal → forwarder's internal IP:
docker run --rm --network trent-spike-int --add-host host.docker.internal:172.22.0.3 alpine:3 …
  (proxy path) wget http://host.docker.internal:8888/  → 200, host listener's HTML     [PASS]
  (a) nc -vz -w3 1.1.1.1 443                 → "Network unreachable"  rc=1              [PASS]
  (a2) nc -vz -w3 172.17.0.2 9099 (fwd's bridge IP, escape attempt) → "Network unreachable" rc=1 [PASS]
  (dns) nslookup example.com                 → SERVFAIL                                 [PASS]
```

Verdict: the internal-only sandbox reaches the host proxy **only** through the forwarder, cannot reach
any public IP, cannot hop onto the bridge via the forwarder's bridge IP (off-subnet → dropped), and
cannot resolve external names. A `curl --noproxy '*' https://<any-ip>` fails at L3 (`Network
unreachable`) because the only in-subnet peer is the forwarder, whose sole upstream is the proxy.

## Platform verdict (Desktop vs Linux)

- **Docker Desktop (this host):** `--internal` blocks the proxy alias; the forwarder sidecar is
  required to bridge internal → host proxy. Measured above.
- **Linux (by inference, not run here):** `--internal` likewise drops off-subnet traffic; the forwarder
  reaches the host over its bridge leg via the gateway `172.17.0.1`, which the proxy already binds on
  Linux (`bind-hosts.ts:57`). Same topology; only the host-gateway IP differs. **Re-measure on Linux
  CI before shipping the Linux path.**

## Recommended mechanism (ONE)

**Per-seat `--internal` network + a minimal dual-homed forwarder sidecar.** The egress sandbox joins
only the internal net; a forwarder container joins the internal net and a routable bridge and relays
one port to the host proxy. This is pure topology (no caps needed), blocks all non-proxy L3
destinations, kills DNS-over-UDP exfil for free, and fails closed.

Exact docker args Trent should emit (per seat, `label` from `sandbox.ts:61`):

```
# 1. per-seat internal network (own subnet ⇒ no cross-seat lateral movement; no external route)
docker network create --internal trent-egress-<label>

# 2. forwarder sidecar: internal + bridge, relays <PROXY_PORT> → host proxy
docker create --name trent-fwd-<label> --network trent-egress-<label> \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --add-host host.docker.internal:host-gateway <tiny-relay-image>   # relay :PROXY_PORT → host.docker.internal:<hostProxyPort>
docker network connect bridge trent-fwd-<label>     # Linux: bridge gateway 172.17.0.1 reaches host proxy
                                                     # Desktop: host.docker.internal → host loopback

# 3. egress sandbox: ONLY the internal net; host.docker.internal points at the forwarder
docker create --name trent-seat-egress-<label> --network trent-egress-<label> \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit 256 \
  --add-host host.docker.internal:<forwarder-internal-ip> \
  -e HTTPS_PROXY=http://host.docker.internal:<PROXY_PORT> -e HTTP_PROXY=… <image>
```

(The isolated sandbox stays `--network none` unchanged.) Prefer running the relay as **socat**
(`socat TCP-LISTEN:<PROXY_PORT>,fork,reuseaddr TCP:host.docker.internal:<hostProxyPort>`) baked into a
pinned image, or fold the relay into a dual-homed proxy container later. The forwarder's internal IP is
read with `docker inspect … {{(index .NetworkSettings.Networks "trent-egress-<label>").IPAddress}}`
after create; wire it into the sandbox's `--add-host`.

## Proxy-bind change

**None on the listener side.** The host proxy keeps binding loopback on macOS and loopback+bridge
gateway on Linux (`bind-hosts.ts` unchanged) — the forwarder reaches it exactly as the egress
container does today. What changes is in `tools/sandbox.ts` / `DockerBackend.ts`: the egress
sandbox's `extraHosts` becomes `host.docker.internal:<forwarder-internal-ip>` (not
`:host-gateway`), it joins the per-seat internal net instead of `DEFAULT_BRIDGE`, and
`DockerSandbox.create`/`cleanup` (`:83,:122`) must create/connect/remove the network + forwarder.
`proxyUrl` stays `http://host.docker.internal:<port>`.

## DNS story

`--internal` already yields SERVFAIL for external names (upstream unroutable), so DNS-over-UDP exfil
is closed without extra flags. `host.docker.internal` and same-net container names still resolve from
`/etc/hosts` / embedded resolver, which is required. Recommend also dropping
`ping|dig|nslookup|host|nc|ssh|scp|rsync` from `NEEDS_EGRESS` (`tools/terminal/adapter.ts:40-41`):
none work through an HTTP proxy and each is a probe/exfil primitive.

## Fail-closed condition

If the per-seat internal network cannot be created, the forwarder cannot be created/connected, or the
forwarder cannot reach the host proxy, **create no egress container at all**. Network-needing terminal
commands then return the existing `[no network: …]` note (`adapter.ts:118`), `trent doctor` prints the
reason, and the only override to today's proxy-honour-only bridge must print a warning. Never silently
fall back to the default bridge.

## `terminal.docker.network` — live or dead?

**Live schema key, dead wiring.** Defined with default `"bridge"` in `config/defaults.ts:32` and
`config/sections/terminal.ts:17`; `tools/types.ts:88` has `docker.bridgeNetwork`. But
`tools/index.ts:290` builds `docker: { image }` **only** — it never passes `network`, so
`sandbox.ts:79` (`this.ctx.docker?.bridgeNetwork ?? DEFAULT_BRIDGE`) always uses `"bridge"`. The
config value never reaches the sandbox. SEC-1 should either repurpose it as the network *mode*
(`internal|none`) and wire it, or delete it (and regenerate the schema snapshot).

## Cleanup verification

```
docker ps -a | grep trent-spike        → NONE
docker network ls | grep trent-spike   → NONE
lsof -iTCP:9099 -sTCP:LISTEN           → NONE
```
