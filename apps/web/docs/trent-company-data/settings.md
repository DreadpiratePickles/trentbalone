# Trent — Settings Page Values

Paste these values into Settings when creating the Trent company inside the app.

---

## Company Profile

| Field | Value |
|---|---|
| **Company name** | Trent |
| **Slug** | trent |
| **Website** | https://trent.app |
| **Timezone** | America/New_York |

---

## Operating Mode

| Field | Value |
|---|---|
| **Autonomy level** | `autonomous_with_approvals` |
| **Cycle frequency** | `daily` |
| **Nightly run hour (UTC)** | `7` (3 AM ET) |
| **Public visibility** | Enabled |
| **Public subdomain** | trent |

---

## Budget

| Field | Value |
|---|---|
| **Monthly AI budget (cents)** | `25000` ($250 / mo) |
| **Weekly budget cap (cents)** | `6000` ($60 / wk) |
| **Per-run task budget (cents)** | `500` ($5) |

---

## Approval Rules

These actions require human approval before the agent executes:

- Publishing any blog post or public-facing content
- Merging a pull request to main
- Sending outbound email campaigns
- Charging or refunding a customer
- Changing pricing or billing configuration
- Posting to social media accounts
- Making changes to production infrastructure

---

## Agent Roster (Agents page)

Create one agent per row:

| Role | Name | Notes |
|---|---|---|
| `ceo` | Trent CEO | Runs daily cycles, writes OKR summaries, triages approvals |
| `engineer` | Trent Engineer | Builds features, reviews PRs, writes tests, deploys |
| `growth` | Trent Growth | Runs experiments, manages ads, writes copy variants |
| `content` | Trent Content | Blog posts, changelogs, docs, release notes |
| `support` | Trent Support | Answers tickets, escalates bugs, writes FAQs |
| `analyst` | Trent Analyst | Metrics dashboards, cohort analysis, weekly reports |
| `finance` | Trent Finance | Invoice tracking, burn rate, monthly close memo |

---

## Integrations to connect

| Integration | Purpose |
|---|---|
| GitHub | PR review, deploy triggers, changelog generation |
| Linear | Task sync — agent creates issues from cycle output |
| Stripe | Revenue metrics, invoice alerts, churn detection |
| Resend | Transactional email (changelogs, support replies) |
| Cloudflare R2 | Artifact and asset storage |
| Sentry | Error monitoring fed into engineer agent context |
| PostHog | Product analytics fed into analyst and growth agents |
| Slack | Approval notifications, daily briefing delivery |
