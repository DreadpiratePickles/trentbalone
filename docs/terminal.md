# Terminal backends

A backend is where an agent-authored command actually runs. Four are declared in the config schema.
Two execute commands. Two return a canned string.

```yaml
terminal:
  backend: docker             # docker | ssh | e2b | local
  docker:
    image: trent-sandbox:latest
    network: bridge
  ssh:
    host: build-01.internal
    port: 22
    user: trent
    key_path: ~/.ssh/id_ed25519
```

## Status

| Backend | Id | Runs commands | Notes |
|---|---|:---:|---|
| Docker sandbox | `docker` | yes | The only real isolation |
| Local execution | `local` | yes | No isolation. Named "Local Execution Backend (Development Only)" in the source |
| Remote SSH | `ssh` | no | `execute` returns `[SSH Mock Backend: executed on user@host:port]` |
| E2B cloud microVM | `e2b` | no | `execute` returns `[E2B Sandbox]: executed command: <command>` |

Choosing `ssh` or `e2b` today gives you a string that looks like success, exit code 0, and no work
performed. Do not use them.

## Docker

The real one. Every process is spawned with `execFile` and an argument array; no host shell is ever
involved. The only shell that sees an agent-authored command is `sh -c` inside the container, which
receives it as one opaque argv element.

Container flags applied on create:

- `--network` from `terminal.docker.network`. `none` is full isolation; a named bridge is used when
  egress is proxied.
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
trent sandbox build --json       # {"image":"trent-sandbox:1","dockerfile":"...","built":true,...}
```

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

Where that proxy listens depends on the platform. The bridge container reaches it as
`http://host.docker.internal:<port>` through `--add-host host.docker.internal:host-gateway`. On
Docker Desktop (macOS, Windows) the VM forwards that alias to the host's loopback, so a
`127.0.0.1` listener is enough. On Linux the alias resolves to the bridge **gateway**
(`172.17.0.1` by default), and a loopback-only proxy is unreachable from the container:
`curl: (7) Failed to connect to example.com:443 over proxy host.docker.internal`. So on Linux
with the Docker backend the REPL also binds the gateway address, discovered with
`docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'` (falling back to
`172.17.0.1`). The proxy never binds `0.0.0.0` or `::`; `EgressProxy` throws on a wildcard, and
`egressBindHosts` never produces one. The extra listener enforces the same two gates as loopback
(host allowlist at CONNECT, session token on every request), which
`EgressProxy.test.ts` proves by sending a tokenless request to the non-loopback listener and
getting `407`; see the threat model in `scripts/installer/THREAT-MODEL.md`.

## Not yet implemented

- Real SSH execution, host key verification, key-based authentication.
- Real E2B microVM execution.
- A published `trent-sandbox` image (it is built locally by `trent sandbox build`).
- A PTY backend of any kind.
- Automatic mounting of the egress CA into a running container. The certificate and the environment
  are built; the mount is not wired into every path.
