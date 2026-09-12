# Terminal Backends & Isolation

Trent isolates all agent-executed bash commands and test runners inside structured sandbox backends.

---

## Supported Backends

### 1. Local PTY Backend (`local`)
- Spawns subprocesses using native PTY pseudoterminals.
- Ideal for fast local development and interactive terminal commands.
- Enforces timeout limits and environment variable sanitization (preventing secret leakage).

### 2. Docker Sandbox Backend (`docker`)
- Executes commands within an isolated Docker container (default: `alpine:latest` or custom dev container).
- Mounts only designated project files into `/workspace`.
- Blocks network egress unless explicitly whitelisted.
- Prevents any modifications to host operating system files.

### 3. SSH Remote Backend (`ssh`)
- Dispatches execution to a remote Linux worker or cloud server over SSH.
- Supports public key authentication and host key verification.
- Perfect for heavy build tasks, GPU training jobs, or isolated staging servers.

---

## Configuration

In `~/.trent/config.yaml`:

```yaml
terminal:
  backend: "docker"                # local, docker, ssh
  sandbox_dir: "~/.trent/sandbox"
  timeout_ms: 300000              # 5 minute hard limit
  docker_image: "node:20-alpine"
  env_whitelist:
    - "PATH"
    - "NODE_ENV"
    - "HOME"
```

---

## Egress Credential Proxy

When agents execute web searches, API calls, or curl commands, Trent's **Egress Proxy** intercepts outgoing HTTP/HTTPS traffic:
- Secret tokens (e.g. `sk-live-...`, Stripe keys) are stored only in the secure proxy memory.
- Subprocesses receive temporary short-lived opaque tokens (`egress_tok_...`).
- The proxy rewrites outgoing headers to attach the real credential before reaching external APIs.
- Even if a subagent's code prints all environment variables or logs HTTP requests, real API keys are never exposed.

Run the standalone proxy daemon:
```bash
trent egress
```
