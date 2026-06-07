# Feature Flags

Related: [[roadmap]]

All feature flags are in PostHog. Default: off unless noted.

---

| Flag key | Default | Description |
|---|---|---|
| `workbench_ga` | off | Enables Workbench/Trenchpad for all users. Currently limited to beta |
| `marketplace_alpha` | off | Agent Marketplace — restricted to 10 alpha users |
| `morning_briefing_v2` | off | New digest format for morning briefing |
| `autonomous_cycles` | on (paid) | Nightly autonomous cycles. Free tier: off |
| `multi_model_picker` | on | Model picker in Command (Sonnet / Opus / GPT / Gemini) |
| `vault_graph` | on | Backlinks graph view in Vault |
| `social_posting` | off | Social media publishing from Content agent |
| `ads_autopilot` | off | Growth agent manages Meta/Google budgets autonomously |

---

## How to flip a flag

1. Go to PostHog → Feature Flags
2. Find the flag by key
3. Set rollout % or target by user email / company ID
4. Trent picks up the flag on next cycle

## Flags that require engineer review before enabling

- `ads_autopilot` — touches real ad spend; needs spend cap validation
- `marketplace_alpha` — billing integration not fully wired
- `social_posting` — needs content approval workflow hardened first
