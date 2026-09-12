// Landing page copy and data. Brand voice per brand book ed.02 —
// verb-first, lowercase mono labels, honest about supervision levels.

export const MARQUEE_WORDS = [
  "ships code",
  "runs growth tests",
  "tracks burn",
  "drafts replies",
  "reviews contracts",
  "writes the Sunday letter",
  "builds backlog",
  "monitors vendors",
  "never sleeps",
  "stays in budget",
  "logs every decision",
  "surfaces the signal",
  "escalates smart",
  "owns the ops",
];

export const AGENTS = [
  { code: "PM", name: "product manager", desc: "Prioritises backlog. Ships specs. Closes loops.", label: "supervised" },
  { code: "EG", name: "engineer", desc: "Writes, reviews, and merges production-quality code.", label: "supervised" },
  { code: "GR", name: "growth", desc: "Experiments, measures, doubles down on signal.", label: "supervised" },
  { code: "FN", name: "finance", desc: "Tracks burn, forecasts runway, flags anomalies.", label: "autonomous" },
  { code: "MK", name: "marketing", desc: "Drafts copy, schedules posts, monitors brand.", label: "supervised" },
  { code: "OT", name: "ops", desc: "Handles tooling, infra health, and vendor relations.", label: "autonomous" },
  { code: "CS", name: "customer success", desc: "Reads tickets, drafts replies, escalates edge cases.", label: "supervised" },
  { code: "LG", name: "legal", desc: "Reviews contracts, flags risk, keeps you compliant.", label: "supervised" },
  { code: "ST", name: "strategy", desc: "Weekly synthesis. Pattern recognition. Sunday letter.", label: "experimental" },
];

export const HIRE_TABLE = [
  { role: "Head of Product", salary: 150, agent: "PM" },
  { role: "Lead Engineer", salary: 180, agent: "EG" },
  { role: "Growth Manager", salary: 120, agent: "GR" },
  { role: "Finance Lead", salary: 130, agent: "FN" },
  { role: "Marketing Manager", salary: 110, agent: "MK" },
  { role: "Ops Manager", salary: 100, agent: "OT" },
  { role: "Customer Success", salary: 80, agent: "CS" },
  { role: "Legal Counsel", salary: 120, agent: "LG" },
  { role: "Chief of Staff", salary: 110, agent: "ST" },
];

export const NEEDS_DOING = [
  { q: "Ship that bug fix?", a: "EG writes the PR, runs tests, opens a draft for your approval.", code: "EG" },
  { q: "Grow the waitlist?", a: "GR designs the experiment, runs it, reports what moved.", code: "GR" },
  { q: "Know your runway?", a: "FN pulls the numbers, flags anomalies, posts the summary.", code: "FN" },
  { q: "Reply to that customer?", a: "CS reads the ticket, drafts the response, routes edge cases to you.", code: "CS" },
  { q: "Review that contract?", a: "LG parses every clause, flags the risk, writes plain-English notes.", code: "LG" },
  { q: "Write the strategy memo?", a: "ST synthesises the week, spots the pattern, writes the Sunday letter.", code: "ST" },
];

export const OVERNIGHT_LOG = [
  { t: "02:14", a: "FN", msg: "pulled Stripe charges · runway 7.2 months · flagged 1 anomaly" },
  { t: "02:31", a: "OT", msg: "vendor health check complete · all systems nominal" },
  { t: "03:08", a: "CS", msg: "triaged 4 tickets · 3 drafted · 1 escalated to queue" },
  { t: "04:45", a: "EG", msg: "reviewed open PRs · posted 2 review comments · ready for your merge" },
  { t: "06:00", a: "ST", msg: "morning briefing assembled · 3 priorities · 1 decision required" },
];

export const REAL_OUTPUTS = [
  {
    icon: "doc" as const,
    kind: "board deck",
    title: "Board Update — Q2 2025",
    agent: "@CEO",
    agentColor: "var(--pulse)",
    meta: "16 slides · PDF · ready to send",
    blurb: "Revenue: $82k MRR (+18% MoM). Runway: 14 months. Three asks from the board.",
    status: "ready",
  },
  {
    icon: "search" as const,
    kind: "market research",
    title: "Competitor Analysis: Pricing Tier Gaps",
    agent: "@Analyst",
    agentColor: "#A5B4FC",
    meta: "11 pages · PDF · 47 sources cited",
    blurb: "Four incumbents underserve the $500–$2k/mo SMB bracket. Recommend a new mid tier.",
    status: "ready",
  },
  {
    icon: "github" as const,
    kind: "github pull request",
    title: "feat: add retry logic to email sender",
    agent: "@Engineer",
    agentColor: "#67E8F9",
    meta: "3 files · +84 / -12 lines · tests pass",
    blurb: "Exponential backoff, max 3 attempts, dead-letter queue on final failure.",
    status: "merged",
  },
  {
    icon: "wallet" as const,
    kind: "churn report",
    title: "Monthly Churn Dashboard — May",
    agent: "@Finance",
    agentColor: "#FDE68A",
    meta: "XLSX · 4 sheets · 3 charts",
    blurb: "Net churn 1.4%. Cohort analysis shows 90-day cliff. Action: extend trial to 21 days.",
    status: "ready",
  },
  {
    icon: "inbox" as const,
    kind: "investor update",
    title: "May Investor Update",
    agent: "@Content",
    agentColor: "#F9A8D4",
    meta: "Email · 340 words · sent to 12 investors",
    blurb: "Shipped: comment threads, artifact exports, demo mode. Asking: warm intros to 3 funds.",
    status: "sent",
  },
];

export const STATUS_COLORS: Record<string, string> = {
  ready: "var(--pulse)",
  merged: "#A5B4FC",
  sent: "#67E8F9",
  pending: "var(--ember)",
};

export const TRUST_ITEMS = [
  {
    icon: "shield" as const,
    title: "Your credentials never touch the AI",
    body: "API keys and secrets are encrypted at rest. The model only receives redacted references — never raw tokens.",
  },
  {
    icon: "check" as const,
    title: "You approve every external action",
    body: "Trent stops before committing, sending, publishing, charging, or deploying. You see the full plan before anything moves.",
  },
  {
    icon: "building" as const,
    title: "Isolated workspaces per company",
    body: "Each company runs in a separate context. Cross-tenant data access is structurally impossible, not just policy-blocked.",
  },
  {
    icon: "x" as const,
    title: "Zero training on your data",
    body: "Trent runs on Anthropic and OpenAI enterprise contracts. Your company data is never used to train any model.",
  },
];

export const PLANS = [
  {
    name: "Operator",
    monthlyPrice: 99 as number | null,
    description: "One company, all 9 agents, daily cycles.",
    features: ["1 company workspace", "All 9 agent roles", "Daily autonomous cycles", "Approval queue", "Memory + RAG", "$100/mo model budget"],
    cta: "hire trent",
    highlight: false,
  },
  {
    name: "Studio",
    monthlyPrice: 299 as number | null,
    description: "Up to 5 companies, higher model budget, priority support.",
    features: ["Up to 5 company workspaces", "All 9 agent roles per company", "Continuous cycle scheduling", "Approval + escalation rules", "GitHub, Stripe, Postmark integrations", "$500/mo model budget", "Priority support"],
    cta: "hire trent",
    highlight: true,
  },
  {
    name: "Enterprise",
    monthlyPrice: null as number | null,
    description: "Unlimited companies, RBAC, audit export, SLA.",
    features: ["Unlimited companies", "SOC 2 Type II (in progress)", "RBAC + custom agent routing", "Tamper-evident audit log", "Custom model budget", "Dedicated Slack support"],
    cta: "talk to us",
    highlight: false,
  },
];

export const SUNDAY_BULLETS = [
  "What shipped this week",
  "What got stuck — and why",
  "The one thing to focus on next",
];

export const STATS = [
  { value: 1, prefix: "$", suffix: "M+", label: "in salaries replaced" },
  { value: 0, prefix: "", suffix: "", label: "ops tax" },
  { value: 9, prefix: "", suffix: "", label: "specialist roles" },
  { value: 24, prefix: "", suffix: "-7", label: "operating coverage" },
];

export const CHAPTERS = [
  { id: "top", label: "intro" },
  { id: "hire", label: "the hire" },
  { id: "tasks", label: "tasks" },
  { id: "agents", label: "agents" },
  { id: "outputs", label: "outputs" },
  { id: "pricing", label: "pricing" },
];
