# Trent Doctor Diagnostics

`trent doctor` runs automated diagnostic checks across your environment, dependencies, credentials, fleet integrity, and execution sandboxes.

```
   ██████╗  ██████╗  ██████╗████████╗ ██████╗ ██████╗ 
   ██╔══██╗██╔═══██╗██╔════╝╚══██╔══╝██╔═══██╗██╔══██╗
   ██║  ██║██║   ██║██║        ██║   ██║   ██║██████╔╝
   ██║  ██║██║   ██║██║        ██║   ██║   ██║██╔══██╗
   ██████╔╝╚██████╔╝╚██████╗   ██║   ╚██████╔╝██║  ██║
   ╚═════╝  ╚═════╝  ╚═════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝
        ⚕ SYSTEM DIAGNOSTICS & FLEET READINESS ⚕
```

---

## The 12 Diagnostic Checks

| # | Check Category | Description | Auto-Fixable |
|---|----------------|-------------|:------------:|
| 1 | **Config** | Validates YAML syntax, schema version, and directory structure. | Yes |
| 2 | **Credentials** | Validates presence of active LLM provider API keys in secrets store. | No |
| 3 | **Agents** | Verifies installed cofounders exist in the 164-specialist catalog. | Yes |
| 4 | **Skills** | Checks installed skills against syntax and security policies. | Yes |
| 5 | **MCP** | Audits Model Context Protocol server health, trust scores, and timeouts. | Yes |
| 6 | **Connectivity** | Tests egress network latency to OpenAI, Anthropic, and Google APIs. | No |
| 7 | **Database** | Checks SQLite / session store integrity and lock states. | Yes |
| 8 | **Cron** | Inspects background scheduled automation daemons for deadlocks. | Yes |
| 9 | **Disk** | Verifies log directory size and storage limits (under 500 MB). | Yes |
| 10 | **Dependencies** | Ensures `git`, `node` (20+), `npm`, and sandbox runtimes are present. | No |
| 11 | **Workbench** | Validates sandbox backend (Local PTY, Docker, or SSH). | Yes |
| 12 | **Self-Improvement**| Checks GEPA prompt evolutionary store and test eval harness readiness. | Yes |

---

## Usage

### Run Diagnostics
```bash
trent doctor
```

### Automated Remediation
Automatically resolve safe issues (creating missing configs, purging expired logs, repairing broken symlinks):
```bash
trent doctor --fix
```

### Structured JSON Output
Integrate doctor checks into CI/CD or automated deployment scripts:
```bash
trent doctor --json
```

Exit Codes:
- `0`: All checks passed.
- `1`: One or more errors found.
- `2`: Warnings present (system operational with caveats).
