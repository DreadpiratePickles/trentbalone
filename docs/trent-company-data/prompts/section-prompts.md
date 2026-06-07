# Trent Section-by-Section Test Prompts

Use these prompts to exercise every part of the app with Trent running itself.
All prompts assume you are logged in and have the **Trent** company selected.

---

## 1. Console (Dashboard)

The dashboard is mostly read-only but you can trigger a cycle here.

**What to verify:**
- Company name shows "Trent"
- Agent roster shows 7 roles
- Activity feed populates after running a cycle
- "Run cycle" button works

**Action prompts:**
```
Click "Run cycle now" — confirm a job run appears in the recent activity feed.
```

---

## 2. Command — Ask mode

Switch mode to **Ask** before sending these.

```
What's the current status of the company?
```
```
What does our memory say about our ideal customer profile?
```
```
How much have we spent on AI this week?
```
```
What approvals are waiting for me right now?
```
```
Summarize the last cycle's results.
```
```
What are our current Q2 priorities?
```
```
What does the vault say about our launch checklist?
```

---

## 3. Command — Agent mode

Switch mode to **Agent** before sending these. Each one hands off a scoped task.

```
Write a changelog entry for the Workbench feature. Use the product spec in memory.
```
```
Draft a response to a customer who says "I don't trust AI to run my company."
Pull from our objection handling doc in the vault.
```
```
Create a task for the engineer agent: add unit tests for the withRlsContext wrapper.
```
```
Write a 280-character tweet announcing that Trent can now run itself.
```
```
Analyze our pricing tiers and suggest which tier would drive the most trial-to-paid conversion.
```
```
Draft the subject line and first paragraph of our "you just signed up" welcome email.
```

---

## 4. Command — Autonomous mode

Switch mode to **Autonomous** before sending. These trigger a full company cycle.

```
Run the morning briefing and summarize everything that needs my attention today.
```
```
Review all open tasks across every agent role and move anything that's been blocked
for more than 24 hours into waiting_approval so I can unblock it.
```
```
Prepare a one-page investor update for Q2 2026 using data from memory, the vault,
and recent cycle history.
```

---

## 5. Workbench — Build mode

Start a new session with **Build** mode.

```
Build a /api/health endpoint that returns { status: "ok", version: "1.0.0", timestamp: <iso> }.
Add a unit test that asserts all three fields are present.
```
```
Add a missing `updated_at` column to the `Agent` table in the Prisma schema.
Write the migration, update the type, and update any places that read the Agent type.
```
```
Create a new React component <BudgetRing /> that shows a circular progress ring
for current spend vs. budget. Props: spentCents, budgetCents. Use the existing
design tokens (navy background, blue accent, muted text colors).
```
```
Write a script that reads all companies from the DB and logs the name, cycle frequency,
and last cycle timestamp for each. Run it and show me the output.
```

---

## 6. Workbench — Research mode

Start a new session with **Research** mode.

```
Research the current state of AI agent frameworks (LangGraph, CrewAI, AutoGen, Claude agents)
and write a comparison focused on: multi-agent coordination, tool use, approval workflows,
and cost control. Include links to primary sources.
```
```
Research what solo founders say are their biggest operational pain points.
Look at HN threads, Reddit r/SaaS, and Indie Hackers. Synthesize into a top 5 list
with direct quotes.
```
```
Research competitor pricing: Devin, Cursor Business, Notion AI Teams, Zapier AI.
Create a comparison table showing price, what's included, and key limits.
```

---

## 7. Workbench — Design mode

Start a new session with **Design** mode.

```
Design a landing page hero section for Trent. Target audience: solo technical founders.
Include: headline, subheadline, primary CTA, social proof element.
Produce a detailed design spec with copy, layout description, and color usage.
Use the brand voice from our guidelines (direct, no hype, numbers beat adjectives).
```
```
Design the empty state for the Queue page when no tasks are pending.
It should feel encouraging, not empty. Include illustration concept and copy.
```

---

## 8. Queue

The queue shows pending tasks. Use Command first to generate tasks, then check here.

**Test prompts (send in Command → Agent mode first):**
```
Create 5 tasks for the content agent: write blog post drafts for each of our
5 main ICP pain points. Queue them all with priority medium.
```

**Then in Queue, verify:**
- All 5 tasks appear
- Status is `queued`
- Priority, agent role, and created time are visible
- You can cancel one task from the queue

---

## 9. Approvals

Approvals appear when an agent pauses for human review.

**To generate an approval (send in Command → Agent mode):**
```
Draft a tweet thread (5 tweets) announcing Trent's public launch.
Submit it for approval before posting.
```
```
The engineer agent has completed the /api/health endpoint. Create an approval
request to merge the changes to main.
```

**In Approvals, verify:**
- Approval cards show agent role, task summary, and proposed action
- "Approve" and "Reject" buttons work
- Approving a content approval marks the task as completed
- Rejecting shows a reason input (or notes field)
- Bulk approve works on up to 5 approvals at once

---

## 10. Reports

Reports are generated by agents on a schedule or on demand.

**To generate a report (Command → Agent mode):**
```
Generate a morning briefing for today. Include:
- Open approvals count
- Tasks completed yesterday
- Current budget utilization
- Top 3 items that need my attention
```
```
Write a weekly operating report for the week of June 2, 2026.
Sections: what we shipped, what's blocked, AI spend summary, one metric that moved.
```
```
Generate an investor update for Q2 2026.
Use data from memory (company overview, priorities) and vault (roadmap, launch checklist).
Format: 1 page, bullet points, include MRR target and current status.
```

**In Reports, verify:**
- Reports appear in the list with type, generated date, and status
- Opening a report shows formatted content
- Reports have export options (markdown, PDF)

---

## 11. Artifacts

Artifacts are files created by agents — spreadsheets, PDFs, dashboards.

**To generate artifacts (Command → Agent mode):**
```
Create a competitive analysis artifact comparing Trent vs. Devin vs. Notion AI.
Format: XLSX with three sheets: feature comparison, pricing comparison, ICP overlap.
```
```
Create a board summary PDF for Q2 2026. Include: company mission, top 3 milestones,
MRR snapshot, next quarter priorities. Mark it needs_approval before sending.
```

**In Artifacts, verify:**
- Artifacts show type badge (xlsx_report, board_pdf, etc.)
- Status flows (draft → needs_approval → approved)
- Download / export works
- Approving an artifact changes its status to `approved`

---

## 12. Memory

Memory files are uploaded by the founder and read by all agents.

**Upload flow:**
1. Upload each file from `docs/trent-company-data/memory/` (01 through 07)
2. Wait for "indexed" confirmation on each

**Test prompts (after upload, in Command → Ask mode):**
```
What does our memory say our ICP's biggest pain point is?
```
```
According to memory, what are the three things the engineer agent is not allowed to do without approval?
```
```
What is our pricing for the Growth tier?
```
```
According to our brand guidelines, what words are we never allowed to use in copy?
```
```
What are the current Q2 priorities?
```

**Verify:**
- Each answer cites the source file
- Agent doesn't hallucinate details not in the uploaded docs
- Memory freshness indicator shows source count and chunk count

---

## 13. Vault (Wiki)

The vault is the linked note knowledge base. Create notes from the `vault/` folder.

**Create notes in this order (preserves backlinks):**
1. `product/roadmap.md`
2. `product/feature-flags.md`
3. `engineering/architecture.md`
4. `engineering/deploy-runbook.md`
5. `go-to-market/positioning.md`
6. `go-to-market/launch-checklist.md`

**Test prompts in the Vault ask box:**
```
What are the gate criteria before we can release the next version?
```
```
Which feature flags need engineer review before enabling?
```
```
What does the deploy runbook say to do after a Prisma schema change?
```
```
What's our Product Hunt launch target date and what's the upvote goal?
```
```
What objection handling do we have for "I don't trust AI"?
```

**Verify:**
- Tree shows folder structure (product / engineering / go-to-market)
- Clicking a note shows title, summary, and source links
- Backlinks panel shows cross-references (e.g., roadmap ↔ positioning)
- Graph view shows node connections
- Ask-with-citations returns answers with source note names

---

## 14. Cycles

Cycles are the operating heartbeat. One cycle = one full agent sweep.

**In Cycles, verify:**
- Cycle history list shows past runs with status and duration
- Each cycle row expands to show tasks run per agent role
- You can configure: frequency (manual / daily / weekly)
- You can set the nightly run hour

**Test config:**
```
Set cycle frequency to: daily
Set nightly run hour to: 7 (UTC) = 3 AM ET
```

**Trigger a manual cycle and verify in the Cycles list:**
- Status goes: queued → running → completed
- Duration is reasonable (< 5 minutes for a mock run)
- Tasks are logged per agent role

---

## 15. Budgets

Budgets page shows spend controls and current utilization.

**What to verify:**
- Monthly budget shows $250 (25000 cents)
- Weekly cap shows $60 (6000 cents)
- Per-task cap shows $5 (500 cents)
- Current spend vs. budget is visualized
- Alerts at 80% threshold are configured

**Test prompts (Command → Ask mode):**
```
How much have we spent on AI this month?
```
```
Which agent role has spent the most this week?
```
```
Are we on track to hit our monthly budget limit?
```

---

## 16. Audit

The audit log is append-only. Every agent action appears here.

**What to verify after running a cycle:**
- Entries appear for each agent action (task run, tool call, approval created)
- Each entry has: timestamp, agent role, action type, cost, status
- Entries are immutable (no edit/delete UI)
- Hash chain is visible (each entry references predecessor)

**Test filter:**
- Filter by agent role: `engineer` → shows only engineer actions
- Filter by action type: `approval_created`
- Filter by date range: last 24 hours

---

## 17. Integrations

Connected tools that agents use for actions.

**What to verify:**
- All integrations appear in the list
- Status shows: `mocked` (dev), `needs_credentials`, or `connected`
- Each integration has a description of what agent role uses it

**To connect GitHub (real credentials):**
1. Click GitHub → "Connect"
2. Enter your GitHub token (from `/Users/bobby/Desktop/en/trent.env.rtf`)
3. Status changes to `connected`
4. Engineer agent can now create PRs and review code

**Integration test (after connecting GitHub, in Command → Agent mode):**
```
Create a GitHub issue in the trent repo titled "Add /api/health endpoint"
with the description from the build task we just completed.
```

---

## 18. Agent Plug (Marketplace)

Browse and install third-party agents.

**What to verify:**
- Marketplace list shows available agents
- Each agent card shows: name, role slot, description, price/month, rating
- "Install" button triggers a credit check and shows confirmation
- Installed agents appear in the Agents page alongside built-in agents

**Suggested agents to "install" for Trent:**
```
SEO Agent — analyzes pages and writes keyword-optimized meta content
Investor Update Agent — generates weekly investor digest from metrics
Competitive Intelligence Agent — monitors competitor pricing and feature changes
PR & Outreach Agent — drafts press pitches and partnership emails
```

---

## 19. Settings

Fill in all fields from `docs/trent-company-data/settings.md`.

**Verify after saving:**
- Company name: Trent
- Slug: trent
- Autonomy level: autonomous_with_approvals
- Cycle frequency: daily
- Budget values match (monthly $250, weekly $60)
- Approval triggers list matches the rules in settings.md
- Public subdomain: `trent.trent.app` (or localhost equivalent)

---

## 20. Agents Page

Verify the full roster is visible:

| Role | Name | Status |
|---|---|---|
| CEO | Trent CEO | active |
| Engineer | Trent Engineer | active |
| Growth | Trent Growth | active |
| Content | Trent Content | active |
| Support | Trent Support | active |
| Analyst | Trent Analyst | active |
| Finance | Trent Finance | active |

**Click each agent and verify:**
- System prompt is populated with the role's responsibilities
- Budget cap matches the per-task setting ($5)
- Tools list shows appropriate integrations for that role
- Last run timestamp updates after running a cycle

---

## Full end-to-end flow test

Run this sequence to validate the entire system working together:

1. **Upload memory** — all 7 files from `memory/`
2. **Create vault notes** — all 6 notes from `vault/`
3. **Open Command → Autonomous mode** and send:
   ```
   Run a full company cycle. Review all open work across every agent role,
   write a morning briefing, and flag anything that needs my approval.
   ```
4. **Watch Queue** — tasks should appear and advance
5. **Watch Console** — activity feed should populate
6. **Check Approvals** — content and code approvals should appear
7. **Open Reports** — morning briefing should be generated
8. **Check Audit** — every agent action should be logged
9. **Check Budgets** — spend should be recorded
10. **Approve one item** in Approvals — task should complete

If all 10 steps work, Trent is running itself.
