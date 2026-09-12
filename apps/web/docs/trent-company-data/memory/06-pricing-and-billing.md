# Trent — Pricing & Billing

**Upload to Memory so Finance and Growth agents understand revenue model.**

---

## Current pricing tiers

### Free
- 1 company
- 1 agent role (CEO only)
- 50 tasks/month
- Manual cycles only (no autonomous)
- No marketplace agents
- Vault: 10 notes max

### Starter — $49/mo
- 1 company
- 3 agent roles (CEO, Engineer, one more)
- 500 tasks/month
- Daily autonomous cycles
- 1 marketplace agent slot
- Vault: unlimited

### Growth — $149/mo
- 3 companies
- All 7 built-in agent roles
- 2,000 tasks/month
- Autonomous cycles + nightly run
- 3 marketplace agent slots
- Priority model routing (Claude Opus by default)

### Scale — $499/mo
- 10 companies
- All 7 roles × each company
- 10,000 tasks/month
- Unlimited marketplace agents
- Custom approval workflows
- Dedicated Slack support

---

## Usage-based overage

Beyond included tasks:
- $0.10 per additional task (each LLM call counts as one task unit)
- AI cost pass-through: Trent charges at cost + 20% margin
- Marketplace agents: revenue split 70/30 (agent builder / Trent)

---

## Billing system

- Processor: Stripe
- Subscription cycles: monthly, cancel any time
- Trial: 14 days free on any paid tier, no credit card required
- Invoice via Resend on the 1st of each month

## Revenue metrics tracked

- MRR (Stripe webhooks → UsageLedger)
- Churn rate (subscription cancellation events)
- ARPU (MRR / active company count)
- Trial-to-paid conversion rate
- Agent usage by role (which agents drive retention)

---

## Refund policy

- < 48 hours after billing: full refund, no questions
- 48 hours – 14 days: prorated credit, case-by-case
- > 14 days: no refund; Bobby reviews exceptions manually
