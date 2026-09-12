---
name: n8n-mcp
description: Use the n8n MCP server to create, manage, validate, and deploy n8n automation workflows from within Claude Code. TRIGGER when: user says "create an n8n workflow", "automate with n8n", "list n8n workflows", "deploy workflow", "validate n8n", or any request involving n8n workflow automation. The server exposes 20 tools covering node docs, workflow CRUD, execution, and credential management.
---

# n8n-MCP — n8n Workflow Automation via MCP

> **Note:** The canonical published package is `czlonkowski/n8n-mcp` (npm: `n8n-mcp`). If you were directed here from `leonardsellem/n8n-mcp`, this is the correct active package. Source: https://github.com/czlonkowski/n8n-mcp

---

## Setup in Claude Code

### 1. Add to Claude Code MCP config

```bash
claude mcp add n8n-mcp -- npx -y n8n-mcp
```

Or add manually to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "n8n-mcp": {
      "command": "npx",
      "args": ["-y", "n8n-mcp"],
      "env": {
        "N8N_API_URL": "https://your-n8n-instance.com/api/v1",
        "N8N_API_KEY": "your-n8n-api-key"
      }
    }
  }
}
```

### 2. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `N8N_API_URL` | Yes | Your n8n instance REST API base URL (e.g. `https://n8n.yourdomain.com/api/v1`) |
| `N8N_API_KEY` | Yes | API key from n8n Settings → API → Create API Key |

---

## Available Tools (20 total)

### Documentation & Validation (7 tools — no n8n connection needed)

| Tool | Description |
|------|-------------|
| `tools_documentation` | Get usage docs for all MCP tools |
| `search_nodes` | Full-text search across all n8n node types |
| `get_node` | Get node info: properties, operations, credentials, examples |
| `validate_node` | Quick or deep validation of a node configuration |
| `validate_workflow` | Validate an entire workflow JSON including AI agent nodes |
| `search_templates` | Search n8n.io templates by keyword, node type, or task |
| `get_template` | Fetch complete workflow JSON from a template ID |

### n8n Instance Management (13 tools — requires N8N_API_URL + N8N_API_KEY)

| Tool | Description |
|------|-------------|
| `n8n_list_workflows` | List workflows with filtering and pagination |
| `n8n_get_workflow` | Get a workflow by ID (returns JSON) |
| `n8n_create_workflow` | Create a new workflow |
| `n8n_update_full_workflow` | Replace an entire workflow's definition |
| `n8n_update_partial_workflow` | Diff-based partial updates (safer for large workflows) |
| `n8n_delete_workflow` | Delete a workflow permanently |
| `n8n_validate_workflow` | Validate a live workflow by its ID |
| `n8n_autofix_workflow` | Auto-correct common n8n workflow errors |
| `n8n_workflow_versions` | List and restore workflow version history |
| `n8n_deploy_template` | Deploy a template from n8n.io directly to your instance |
| `n8n_test_workflow` | Execute/test a workflow and return results |
| `n8n_executions` | Query execution history — filter by workflow, status, date |
| `n8n_manage_credentials` | Create, list, update, and delete credentials |

---

## Common Usage Patterns

### Search for a node before building a workflow

```
Use search_nodes to find "HTTP Request" node, then get_node with mode="essential" 
to see its required properties before building the workflow JSON.
```

### Build and validate a workflow

```
1. search_nodes to find the nodes you need
2. get_node for each node to understand required params
3. Construct the workflow JSON
4. validate_workflow to catch errors before creating
5. n8n_create_workflow to save it
```

### Deploy a template

```
1. search_templates with keywords matching the task
2. get_template to inspect the JSON
3. n8n_deploy_template to push it to your instance
```

### Debug a failing workflow

```
1. n8n_executions to get recent failures
2. n8n_get_workflow to inspect the definition
3. n8n_validate_workflow for structural issues
4. n8n_autofix_workflow to auto-correct common errors
5. n8n_test_workflow to re-run with a test payload
```

---

## trent-os Integration Notes

n8n-mcp is useful in trent-os for:

- **Automation pipelines**: creating n8n workflows that trigger trent agent cycles (webhook → POST to `/api/cycles/start`)
- **Notification routing**: building approval/notification workflows that route workbench approval events to Slack/email
- **Observability**: creating n8n workflows that consume trent audit log events from a webhook and route them to your SIEM or Notion database
- **Scheduled sweeps**: using n8n's cron trigger to periodically call trent's health endpoint and alert on 503

When creating trent integration workflows:
1. Use `validate_workflow` before `n8n_create_workflow` — always
2. Store trent API keys as n8n credentials via `n8n_manage_credentials`, not inline in workflow nodes
3. Use `n8n_update_partial_workflow` for incremental changes to avoid overwriting large workflows

---

## Troubleshooting

- **Tool not found**: run `tools_documentation` to confirm the server is connected and list available tools
- **N8N_API_KEY rejected**: ensure your n8n instance has API access enabled (Settings → API) and the key has appropriate scopes
- **Workflow validation fails**: use `n8n_autofix_workflow` first; it catches ~80% of common structural errors automatically
- **Connection refused**: check `N8N_API_URL` includes `/api/v1` and your instance is reachable from the machine running Claude Code
