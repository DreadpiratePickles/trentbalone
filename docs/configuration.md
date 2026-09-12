# Configuration & Profiles

Trent stores user configuration, active agents, toolset policies, and secrets inside `~/.trent/config.yaml` and `~/.trent/.env`.

---

## Configuration Schema

Below is an annotated reference of `~/.trent/config.yaml`:

```yaml
version: "1.0.0"
provider: "anthropic"           # openai, anthropic, google, groq, ollama, deepseek
model: "claude-3-7-sonnet"      # Active default model
daily_budget_cap: 10.00         # Maximum USD spent per calendar day
personality: "founder"          # founder, pirate, robot, concise, executive, academic

fleet:
  default_agent: "ceo"          # Agent that handles initial REPL prompts
  active_agents:                # Agents on active duty
    - "ceo"
    - "engineer"
    - "support"
  installed_agents:             # Installed specialist cofounders
    - "ceo"
    - "engineer"
    - "support"
    - "eng-ai-engineer"
    - "mkt-growth-lead"

toolsets:                       # Enabled tool capabilities
  - "file_ops"
  - "terminal"
  - "browser"
  - "git"
  - "search"
  - "mcp"
  - "voice"
  - "cron"
  - "gateway"
  - "egress"

disabled_toolsets: []           # Explicitly blacklisted toolsets

terminal:
  backend: "docker"             # local, docker, ssh
  sandbox_dir: "~/.trent/sandbox"
  docker_image: "alpine:latest"

gateway:
  enabled: true
  platforms:
    telegram:
      enabled: false
      designated_agent: "support"
    discord:
      enabled: false
      designated_agent: "community"
    slack:
      enabled: true
      designated_agent: "engineer"
```

---

## Managing Settings via CLI

### Inspect Configuration
```bash
trent config get provider
trent config get model
trent config get daily_budget_cap
```

### Update Values
```bash
trent config set daily_budget_cap 25.00
trent config set provider openai
trent config set model gpt-5.6-terra
```

### Switch Active Models On the Fly
```bash
trent model claude-3-7-sonnet --provider anthropic
```

---

## Multiple Profiles

You can run isolated workspaces or team configurations using profiles:

```bash
trent --profile work
trent --profile personal
trent doctor --profile client-acme
```

Profile configs are located at `~/.trent/profiles/<profile-name>/config.yaml`.
