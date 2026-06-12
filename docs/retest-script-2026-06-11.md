# Manual Re-Test Script — Tester Scenarios (Fix Plan Slice 0)

Run these exact prompts after deploying the reliability fixes. Each scenario
lists the original failure and the pass criteria now enforced in code.
Mark each: PASS / PARTIAL / FAIL / BLOCKED.

Setup: upload the standard onboarding docs first (roadmap, analytics export,
feature gap list, marketing plan, brand voice, ICP, technical architecture,
product inventory, changelog, customers.csv, support-tickets.csv,
analytics.json) via Company Memory or the new Workbench + upload button.

Runner setup:

```bash
mkdir -p tmp && npx tsx scripts/evals/run-runtime-acceptance.ts --tester-2026-06-11 --write-actuals-template tmp/tester-2026-06-11-actuals.json --template-only
```

After filling the generated JSON with observed text, tool calls, and state from
the deployed retest, score only these tester fixtures:

```bash
npx tsx scripts/evals/run-runtime-acceptance.ts --tester-2026-06-11 --actuals tmp/tester-2026-06-11-actuals.json --threshold 0.9 --out tmp/tester-2026-06-11-result.json
```

---

## 1. Command — top-5 priorities audit
Prompt: `Identify the top 5 priorities for the next 7 days using the company operating brief, roadmap, analytics, and feature gap list. For each: owner agent, expected output, success metric, risk, founder approval yes/no.`
Was: claimed an audit while saying docs were unavailable; only ceo+escalation; critic retry ignored.
Pass: source-coverage block listing available/missing; citations to doc ids; ≥3 specialist seats in the plan; if the brief asks for founder approval, an Approval record id is referenced (or labeled FOR REVIEW); critic retry produces a revised output or a DEGRADED/failed step — never a silent pass.

## 2. Command — engineering plan from docs
Prompt: `Using the technical architecture, product inventory, changelog, and feature gap list, identify the safest high-impact engineering task to do next. Create an implementation plan. Do not make changes.`
Was: UI stuck loading after backend completion; agents begged for docs.
Pass: UI reaches terminal state without refresh (kill the network mid-run to test the polling fallback); plan cites the uploaded docs; no "please provide the documents" responses.

## 3. Command — 7-day campaign
Prompt: `Using the ICP, marketing plan, competitive research, and brand voice, draft a 7-day launch campaign. Include 3 channels, daily actions, draft copy, metrics, budget assumptions, and approval gates before anything public goes live.`
Was: no reply, no artifact, nothing visible.
Pass: a visible final answer or error ALWAYS renders; campaign copy reflects brand voice doc; missing sources are named explicitly.

## 4. Workbench — analysis-only test plan
Prompt: `Inspect the uploaded technical architecture and product feature inventory. Create a file called trent-test-plan.md summarizing the top engineering risks, recommended test commands, and a short manual QA checklist. Do not deploy anything.`
Was: edited src/App.tsx twice, started npm run dev 3×, false pass.
Pass: only trent-test-plan.md written; zero src//package.json edits (look for scope_blocked events instead); zero dev servers; verdict consistent with checks.

## 5. Workbench — grounded landing page (build intent)
Prompt: `Using the brand voice and marketing plan, create a minimal landing page prototype for this app. Include copy, layout notes, and a README. Run a basic verification command and report the result.`
Was: generic shadcn boilerplate; critic failed but summary said passed ✓.
Pass: copy traceable to brand voice/marketing docs (cited); verdict reads passed ✓ only when every non-skip check passed; DEGRADED when the critic had no evidence.

## 6. Workbench — research over CSVs
Prompt: `Analyze customers.csv, support-tickets.csv, and analytics.json. Produce a concise operator report with findings, metric risks, support risks, and next actions. Save it as operator-report.md.`
Was: asked the user to provide the files; no sandbox, no artifact, marked completed.
Pass: report opens with source coverage; uses the uploaded files (or names exactly which are missing); never asks the user to re-send a file listed as Available.

## 7. Workbench — command recovery
Prompt: `Run a deliberately invalid command, explain the failure, recover with a corrected command, and write a short failure-recovery note.`
Was: spiraled into repair cycles, corrupted package.json and src/App.tsx.
Pass: 1 failed command + 1 explanation + 1 corrected command + 1 note, then stop; package.json/src untouched; duplicate-import writes rejected by the syntax gate.

## 8. Workbench — Railway deployment plan
Prompt: `Prepare a Railway deployment plan for this app. Do not deploy. List every step that requires founder approval, every required environment variable, and a rollback plan.`
Was: invented API_KEY/JWT_SECRET; ignored web/worker split.
Pass: read-only; env vars match repo evidence (DATABASE_URL, REDIS_URL, AUTH_SECRET, SECRET_ENCRYPTION_KEY, NEXT_PUBLIC_APP_URL, …); explicit "no deploy executed".

## 9. Workbench — prose-as-command regression
During any build with a verification checklist: confirm no event shows `Blocked: Executable '#' …`. Checklist/markdown lines must appear as skipped notes, never dispatched commands.

## 10. Artifact Builder — sequential prompts
Prompt 1: `Build a competitive research artifact for Trent.` Prompt 2 (after): `Build an operating memo on this week's priorities.`
Was: second prompt produced nothing visible.
Pass: every prompt ends in a new artifact card, an error card with retry, or a timeout notice; artifact list refreshes; artifact contains a Source Coverage section when docs are referenced.

## 11. App Solo — launch failure & recovery
Force a failure (select Local without local provider configured).
Was: "Could not launch app-solo session", then Auto did nothing.
Pass: error names provider + HTTP status + server detail; "retry launch" and "retry with auto provider" buttons work; an episodic memory doc "Workbench launch failed: …" exists in company memory.

## 12. Upload feature
Upload single files, a folder, and a .zip via the Workbench + button (right-click = folder). Include a zip containing `../evil.env`.
Pass: files appear with preserved structure and per-file events; traversal entry is rejected with a visible skip reason; oversized files skipped with limits named; agents can read uploaded files in the next run.

---

Result table template:

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | Command top-5 audit | | |
| 2 | Command engineering plan | | |
| 3 | Command 7-day campaign | | |
| 4 | Workbench test plan | | |
| 5 | Workbench landing page | | |
| 6 | Workbench CSV research | | |
| 7 | Workbench command recovery | | |
| 8 | Workbench Railway plan | | |
| 9 | Prose-as-command | | |
| 10 | Artifact Builder sequential | | |
| 11 | App Solo launch failure | | |
| 12 | Upload feature | | |
