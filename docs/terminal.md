# Terminal backends

A backend is where an agent-authored command actually runs. Two are declared in the config schema,
and both execute commands.

```yaml
terminal:
  backend: docker             # docker | local
  docker:
    image: trent-sandbox:latest
```

## Status

| Backend | Id | Runs commands | Notes |
|---|---|:---:|---|
| Docker sandbox | `docker` | yes | The only real isolation |
| Local execution | `local` | yes | No isolation. Named "Local Execution Backend (Development Only)" in the source |

Schema version 2 also listed `ssh` and `e2b`. Neither ever ran a command: each returned a string
that looked like success with exit code 0. Both classes are deleted, and the v2 -> v3 config
migration rewrites a stored `ssh` or `e2b` to `docker` and reports the change in its notes. A
leftover `terminal.ssh` block in `config.yaml` is accepted and ignored.

## Docker

The real one. Every process is spawned with `execFile` and an argument array; no host shell is ever
involved. The only shell that sees an agent-authored command is `sh -c` inside the container, which
receives it as one opaque argv element.

Container flags applied on create:

- `--network none` for the isolated sandbox — full L3 isolation, the default for every command that
  does not need the network. The egress sandbox instead joins a per-seat `--internal` network behind
  a forwarder sidecar (see [Egress](#egress) below); there is no configurable bridge, and the old
  `terminal.docker.network` key (which never reached the sandbox) has been removed.
- `--cap-drop=ALL`
- `--security-opt=no-new-privileges`
- `--read-only` when a read-only root filesystem is requested
- `--memory` and `--pids-limit` when configured
- Volume mounts, each with an explicit `:ro` when read-only
- `--user <uid>:<gid>` of the `trent` process, **on Linux only, when it is not root**, together
  with `-e HOME=/tmp`. A Linux bind mount keeps the host's ownership, and `--cap-drop=ALL` removes
  `CAP_DAC_OVERRIDE`, so a container running as the image's uid 1000 (or even as root) cannot
  write a workspace owned by uid 1001 with mode 755: every `write_file`, `patch` and `>`
  redirect failed with `EACCES` on ubuntu-latest while passing on macOS, where Docker Desktop
  maps ownership across its VM. Root keeps the image's user because root owns what it mounts;
  macOS and Windows keep it because the mapping already makes the mount writable.
  `HOME` moves to `/tmp` because `/home/sandbox` belongs to uid 1000.

The environment handed to the container is built by `buildSandboxEnv` and contains broker tokens, not
keys. See [security.md](security.md).

The default image is the pinned `trent-sandbox:<version>` build described in the next section. It
is not published anywhere, so `doctor` reports it missing until you build it locally:

```
◆ Sandbox & Workbench   Docker daemon is running (server 29.5.3) but the sandbox image
                        trent-sandbox:1 is not present locally, so execute_code has no
                        python3 or node until it is built.
                        Run `trent sandbox build` to build trent-sandbox:1 from
                        scripts/sandbox/Dockerfile.
```

Point `terminal.docker.image` at any image you already have if you want to try the backend before
that image exists; the REPL falls back to `alpine:3` on its own when the configured image is absent,
which runs `terminal` but makes `execute_code` report "python3 is not available in this sandbox".

## The sandbox image and `trent sandbox build`

`scripts/sandbox/Dockerfile` is the image the seats' `terminal` and `execute_code` tools run inside:
`alpine:3.20` plus `python3` and `nodejs` from its repositories, nothing else. No pip, no npm, and
`apk` is deleted after the install, so nothing can be added at runtime even if a seat found a way to
the network (the backend runs the container with `--network none` unless egress is proxied,
`--cap-drop=ALL` and `no-new-privileges`). A non-root user, `sandbox` (uid 1000), owns
`/workspace`, the mount point the tools use.

The tag is `trent-sandbox:<version>`, never `latest`. The version lives in one place,
`packages/trent-core/src/terminal/sandbox-image.ts` (`SANDBOX_IMAGE`), and `DockerBackend`, the
config default, the tool builder and the doctor all read it from there. Change the Dockerfile,
bump the version: the doctor then reports the old build as absent instead of running stale.

```
trent sandbox build              # docker build -t trent-sandbox:1 -f scripts/sandbox/Dockerfile scripts/sandbox
trent sandbox build --dry-run    # print the argv, run nothing
trent sandbox build --json       # {"image":"trent-sandbox:1","dockerfile":"...","built":true,"sizeBytes":...,"size":"...",...}
trent sandbox build --media      # the media image instead, trent-sandbox-media:1 from scripts/sandbox/media/Dockerfile (docs/media.md)
```

After a build the command asks `docker image inspect --format {{.Size}}` for the image's size
and reports it (`size`, as docker prints it; `sizeBytes`); a daemon that gives no number leaves
both null and the build still counts.

The build ran in about 3 seconds on the dev machine once `alpine:3.20` was local. It is not
`--pull`: BuildKit's registry lookup hit its deadline behind Docker Desktop's proxy there, while a
plain `docker pull alpine:3.20` took minutes and succeeded. The compiled binary has no source tree,
so `TRENT_SANDBOX_DOCKERFILE=<path>` (or `--dockerfile <path>`) names the file to build from.

`.github/workflows/sandbox.yml` builds the image the same way and then runs the gated suite
`packages/trent-core/src/tools/code_execution/sandbox-image.docker.test.ts`, which builds the image
and runs `execute_code` in python and javascript inside it, as uid 1000, with no `apk` and
`NetworkMode=none`. Without a daemon that suite skips, and says so in its title.

## Local

`LocalBackend` runs the command through `child_process.exec` with the host's working directory and
the host's environment. It is not a sandbox, it does not use a pseudo-terminal, and there is no PTY
anywhere in this repository. It is the right choice for development on a machine where you would run
the same commands yourself, and the wrong choice for anything else.

## Command options

Every backend takes the same options: `cwd`, `env`, `timeoutMs`, `proxyToken`. Every backend returns
`{ exitCode, stdout, stderr, durationMs }`. The local backend defaults to a 60-second timeout.

## Egress

Egress credential brokering is documented on its own page: [security.md](security.md). The short
version is that a sandboxed process holds `trnt_egress_…` tokens under the normal key names, routes
through a local TLS-intercepting proxy, and cannot reach a host outside
`egress.intercept_domains`.

### The egress firewall (SEC-1 / T-01)

The allowlist used to bind only clients that honour `HTTPS_PROXY`: the egress container ran on the
default `bridge` with `--add-host host.docker.internal:host-gateway`, so a `curl --noproxy '*'
https://<ip>` or a raw socket reached any host the daemon could. The egress sandbox is now
L3-firewalled by network topology (`packages/trent-core/src/terminal/egress-network.ts`), so the
**only** L3 destination it can reach is the proxy:

- A **per-seat `--internal` Docker network** (`trent-egress-<label>`). An internal network has no
  external route and its own subnet, so there is no public egress and no cross-seat lateral movement.
  As a side effect it also blocks DNS-over-UDP to external names (the upstream resolver is
  unroutable, so public names return SERVFAIL) without adding any resolver.
- A minimal **dual-homed forwarder sidecar** (`trent-fwd-<label>`) that joins both the internal
  network and the `bridge`, and relays exactly one TCP port to the host proxy. It runs a tiny
  python3 TCP relay baked into the **pinned sandbox image** (`SANDBOX_IMAGE`, which carries python3),
  under the same `--cap-drop=ALL` / `no-new-privileges` posture as every sandbox container. No extra
  image is pulled; if the sandbox image is absent the firewall simply fails closed (SEC-2 skips the
  egress container entirely in offline mode anyway).
- The egress sandbox joins **only** the internal network, with `--add-host
  host.docker.internal:<forwarder internal ip>` (never `host-gateway`), so its proxy alias resolves
  to the forwarder and nothing else is routable.

**Fail closed.** If the internal network or the forwarder cannot be built, or the forwarder has no
internal IP, no egress container is created and the caller gets a clear `egress firewall
unavailable: …` reason — there is never a silent fallback to the old bridge.

The **host proxy bind logic is unchanged**. It still listens on loopback (macOS/Windows Docker
Desktop, where the VM forwards `host.docker.internal` to host loopback) and additionally on the
bridge **gateway** on Linux (`172.17.0.1` by default, discovered with `docker network inspect bridge
--format '{{(index .IPAM.Config 0).Gateway}}'`); the forwarder reaches it over its bridge leg
exactly as the egress container used to. The proxy never binds `0.0.0.0` or `::`; `EgressProxy`
throws on a wildcard, and `egressBindHosts` never produces one. Both listeners enforce the same two
gates (host allowlist at CONNECT, session token on every request), which `EgressProxy.test.ts`
proves by sending a tokenless request to the non-loopback listener and getting `407`; see the threat
model in `scripts/installer/THREAT-MODEL.md`. The topology was measured on this Docker Desktop host
in `02_plan/output/security-egress-firewall-spike-2026-09-26.md`.

## Not yet implemented

- A remote (SSH) or cloud microVM (E2B) backend. Neither exists; the earlier entries were mocks.
- A published `trent-sandbox` image (it is built locally by `trent sandbox build`).
- A PTY backend of any kind.
- Automatic mounting of the egress CA into a running container. The certificate and the environment
  are built; the mount is not wired into every path.
