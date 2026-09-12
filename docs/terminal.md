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

The environment handed to the container is built by `buildSandboxEnv` and contains broker tokens, not
keys. See [security.md](security.md).

The default image is `trent-sandbox:latest`. It is not published anywhere, so `doctor` reports it
missing until you build one locally:

```
◆ Sandbox & Workbench   Docker daemon is running (server 29.5.3) but the sandbox image
                        trent-sandbox:latest is not present locally.
```

Point `terminal.docker.image` at any image you already have if you want to try the backend before
that image exists.

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

## Not yet implemented

- Real SSH execution, host key verification, key-based authentication.
- Real E2B microVM execution.
- A published `trent-sandbox` image.
- A PTY backend of any kind.
- Automatic mounting of the egress CA into a running container. The certificate and the environment
  are built; the mount is not wired into every path.
