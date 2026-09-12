import type { AgentRole } from "@/lib/types";
import type { EvalFixture, EvalSuiteInput } from "@/lib/eval-harness";

export type RuntimeAcceptanceSurface = "workbench" | "app_solo" | "command" | "orchestrator" | "artifacts" | "agent_mission";

export type RuntimeAcceptanceEvalFixture = {
  id: string;
  surface: RuntimeAcceptanceSurface;
  ownerSeat: AgentRole;
  objective: string;
  passCriteria: string[];
  regressionTags: string[];
  requires: string[];
};

export type RuntimeAcceptanceActuals = Record<string, {
  text?: string;
  toolCalls?: string[];
  state?: Record<string, unknown>;
}>;

export const TESTER_2026_06_11_TAG = "tester_2026_06_11";

export function buildRuntimeAcceptanceEvalFixtures(): RuntimeAcceptanceEvalFixture[] {
  return [
    fixture(
      "workbench_notes_app_requires_install_build_typecheck_render",
      "workbench",
      "engineer",
      "Build a notes app and verify it like a real product.",
      ["install exits 0", "build/typecheck pass", "preview DOM contains meaningful notes UI", "real screenshot captured"],
      ["notes_app", "verification_contract"],
    ),
    fixture(
      "workbench_placeholder_screenshot_fails",
      "workbench",
      "engineer",
      "Reject placeholder screenshots as verification evidence.",
      ["SVG/text placeholder screenshots fail", "repair prompt includes screenshot failure detail"],
      ["browser_verification", "placeholder_screenshot"],
    ),
    fixture(
      "workbench_blank_react_root_fails",
      "workbench",
      "engineer",
      "Reject blank hydrated app shells.",
      ["visible DOM text is non-empty", "blank React root fails verification"],
      ["dom_verification", "blank_screen"],
    ),
    fixture(
      "workbench_console_error_fails",
      "workbench",
      "engineer",
      "Reject previews with browser console or page errors.",
      ["console errors are captured", "verification fails with exact browser error detail"],
      ["browser_console", "repair_feedback"],
    ),
    fixture(
      "workbench_failed_install_surfaces_repair_feedback",
      "workbench",
      "engineer",
      "Do not bury failed dependency installation.",
      ["failed install blocks verification", "final output includes command excerpt and exit code"],
      ["install_failure", "error_detail"],
    ),
    fixture(
      "workbench_repair_loop_reports_max_attempt_failure",
      "workbench",
      "engineer",
      "Stop repair loops with a clear failure when the cap is hit.",
      ["max attempts stops the loop", "final response lists failed checks and last commands"],
      ["repair_loop", "budget_cap"],
    ),
    fixture(
      "app_solo_starts_and_streams_workbench_run",
      "app_solo",
      "growth",
      "Start an App Solo run and stream live Workbench evidence.",
      ["session is created through Workbench", "trace includes file, command, preview, verify chunks"],
      ["app_solo", "sse_stream"],
    ),
    fixture(
      "command_reconnect_snapshot_shows_reports_and_ceo_summary",
      "command",
      "ceo",
      "Reconnect to a Command autonomous run and replay all reports.",
      ["snapshot contains plan and completed steps", "CEO summary includes each seat report"],
      ["command_reconnect", "ceo_summary"],
    ),
    fixture(
      "ceo_routes_specialist_tools_to_right_seats",
      "orchestrator",
      "ceo",
      "Route Fincept, HyperFrames, browser research, support escalation, sales, and code to the correct seats.",
      ["Fincept routes finance", "HyperFrames routes growth", "code routes engineer", "sales outreach routes sales"],
      ["routing", "specialist_tools"],
    ),
    fixture(
      "content_mission_approval_packet_has_external_action_ledger",
      "orchestrator",
      "ceo",
      "Produce content, publish on social, handle DMs, follow up with leads, and run ads through approval-gated mission orchestration.",
      [
        "CEO Content Approval Packet",
        "External Action Ledger",
        "public_publish",
        "comment_or_dm_reply",
        "email_or_sales_send",
        "paid_spend_or_boost",
        "platform_auth_or_scope_gap",
      ],
      ["content_mission", "approval_packet", "external_action_ledger"],
    ),
    fixture(
      "agent_mission_researches_viral_ideas_and_proposes_angles",
      "agent_mission",
      "analyst",
      "Find viral ideas and propose five content angles.",
      ["trendSignals", "viralFormats", "recommendedAngles", "five content angles", "memory log"],
      ["agent_mission", "research", "viral_ideas"],
    ),
    fixture(
      "agent_mission_creates_content_packet_without_publish",
      "agent_mission",
      "content",
      "Create a launch content packet but do not publish.",
      ["contentBriefs", "scripts", "captions", "creativeAssets", "draft-only", "no public publish"],
      ["agent_mission", "content_packet", "draft_only"],
    ),
    fixture(
      "agent_mission_requires_ceo_approval_before_publish",
      "agent_mission",
      "ceo",
      "Create and schedule a post but require CEO approval before publishing.",
      ["public_publish", "approval_requested", "awaiting_approval", "no external action before approval"],
      ["agent_mission", "publish_approval", "approval_gate"],
    ),
    fixture(
      "agent_mission_requires_finance_approval_before_ad_spend",
      "agent_mission",
      "finance",
      "Draft a paid ad campaign and require finance approval before launch.",
      ["paid_spend_or_boost", "finance", "spend cap", "approval_requested", "no paid spend before approval"],
      ["agent_mission", "ad_spend", "finance_gate"],
    ),
    fixture(
      "agent_mission_routes_angry_comment_to_support_escalation",
      "agent_mission",
      "support",
      "Handle an angry customer comment safely.",
      ["support", "escalation", "comment_or_dm_reply", "escalationTriggers", "no unapproved reply"],
      ["agent_mission", "support_escalation", "reply_gate"],
    ),
    fixture(
      "agent_mission_routes_buyer_dm_to_sales",
      "agent_mission",
      "sales",
      "Route an interested buyer DM to sales.",
      ["sales", "leadCriteria", "outreachDrafts", "email_or_sales_send", "no unapproved send"],
      ["agent_mission", "sales_routing", "buyer_dm"],
    ),
    fixture(
      "agent_mission_research_make_publish_reply_ads_report_e2e",
      "agent_mission",
      "ceo",
      "Research market trends, make content, publish after approval, reply to DMs, launch Meta ads, and report results to CEO.",
      [
        "viral trend research loop",
        "content package",
        "public_publish",
        "comment_or_dm_reply",
        "paid_spend_or_boost",
        "Meta ads",
        "analytics feedback loop",
        "publishing schedule",
        "human approval dashboard",
        "approval_requested",
        "provider_action_executed",
        "social.publish",
        "social.reply",
        "sales.outreach_send",
        "ads.launch",
        "social_inbox_ingested",
        "content_performance_feedback_ingested",
        "memory-log.md",
        "CEO Mission Report",
      ],
      ["agent_mission", "content_social_ads", "e2e_publish_reply_ads", "ceo_report"],
    ),
    fixture(
      "agent_mission_ceo_report_includes_artifacts_costs_metrics_next_actions",
      "agent_mission",
      "ceo",
      "CEO receives a final mission report with artifacts, costs, metrics, and next actions.",
      ["CEO Mission Report", "Artifacts", "Cost", "successMetrics", "Approvals pending", "Next action"],
      ["agent_mission", "ceo_report", "trace_replay"],
    ),
    fixture(
      "same_seat_delegation_skipped_and_logged",
      "orchestrator",
      "ceo",
      "Never create self-delegation loops.",
      ["same-seat work request is skipped", "delegation_skipped event is persisted"],
      ["delegation_loop", "orchestrator_safety"],
    ),
    fixture(
      "artifacts_include_agent_attribution",
      "artifacts",
      "engineer",
      "Every produced artifact identifies the creating seat/agent.",
      ["artifact has createdByAgent", "artifact links to source event or session"],
      ["artifact_attribution", "auditability"],
    ),

    // ── 2026-06-11 tester-note regressions (Fix Plan Slice 0) ──────────────
    fixture(
      "command_source_coverage_required_for_doc_grounded_audits",
      "command",
      "ceo",
      "Identify the top 5 priorities for the next 7 days using the roadmap, analytics, and feature gap list.",
      [
        "output contains a source coverage block (available vs missing)",
        "no claim of a completed audit when sources were missing",
        "doc-grounded claims cite source document ids",
        "plan engages at least three specialist seats, not only ceo/escalation",
      ],
      ["tester_2026_06_11", "source_coverage", "broad_planning_routing"],
    ),
    fixture(
      "command_ui_converges_after_stream_loss",
      "command",
      "ceo",
      "A backend-completed run must never leave the Command UI loading.",
      [
        "SSE reconnect with backoff is attempted",
        "polling fallback reaches terminal status without refresh",
        "saved CEO report renders after stream loss",
      ],
      ["tester_2026_06_11", "terminal_state", "sse_fallback"],
    ),
    fixture(
      "command_campaign_prompt_always_returns_visible_terminal_state",
      "command",
      "growth",
      "Using ICP, marketing plan, competitive research, and brand voice, draft a 7-day launch campaign.",
      [
        "visible final answer or visible error always renders",
        "campaign copy reflects brand voice and marketing plan sources",
        "approval gates are real approvals or explicitly labeled for review",
      ],
      ["tester_2026_06_11", "campaign_grounding", "terminal_state"],
    ),
    fixture(
      "workbench_analysis_prompt_stays_read_only",
      "workbench",
      "engineer",
      "Inspect the docs and create trent-test-plan.md. Do not deploy anything.",
      [
        "exactly the named deliverable is written",
        "no src/ or package.json edits",
        "no dev server starts",
        "out-of-scope actions are blocked with scope_blocked events",
      ],
      ["tester_2026_06_11", "scope_policy", "read_only_analysis"],
    ),
    fixture(
      "workbench_landing_page_uses_brand_and_marketing_sources",
      "workbench",
      "engineer",
      "Using the brand voice and marketing plan, create a minimal landing page prototype.",
      [
        "generated copy cites or reflects brand voice and marketing plan sources",
        "generic starter-template copy fails when grounded docs are available",
        "top-level verdict matches critic and verification sub-checks",
      ],
      ["tester_2026_06_11", "landing_page_grounding", "verification_integrity"],
    ),
    fixture(
      "workbench_command_recovery_does_not_repair_app",
      "workbench",
      "engineer",
      "Run a deliberately invalid command, explain, recover with a corrected command, write a short note.",
      [
        "one failed command, one explanation, one corrected command, one note",
        "package.json and src/ untouched",
        "no repeated repair cycles after recovery succeeds",
      ],
      ["tester_2026_06_11", "command_recovery", "scope_policy"],
    ),
    fixture(
      "workbench_prose_lines_never_executed",
      "workbench",
      "engineer",
      "Verification checklist text is notes, not shell commands.",
      [
        "lines starting with #, -, *, > are never dispatched to the executor",
        "prose lines become skipped notes, not command failures",
      ],
      ["tester_2026_06_11", "command_sanitization"],
    ),
    fixture(
      "workbench_verdict_matches_subchecks",
      "workbench",
      "engineer",
      "A failed or unreviewed critic can never be summarized as passed.",
      [
        "critic fail propagates to top-level FAILED",
        "critic skip after code writes reports DEGRADED, not passed",
        "identical repeated verification failures stop the loop as blocked",
      ],
      ["verification_integrity", "smart_stopping"],
    ),
    fixture(
      "workbench_research_reads_uploaded_files",
      "workbench",
      "analyst",
      "Analyze customers.csv, support-tickets.csv, and analytics.json into operator-report.md.",
      [
        "uploaded files are injected as source documents",
        "missing named files produce a structured missing-source report, not a request to re-send",
        "run is not marked completed when required files were unreadable",
      ],
      ["tester_2026_06_11", "research_grounding", "upload_mounting"],
    ),
    fixture(
      "workbench_deployment_plan_grounded_in_repo_config",
      "workbench",
      "engineer",
      "Prepare a Railway deployment plan. Do not deploy.",
      [
        "read-only: no files written, nothing deployed",
        "env vars come from repo evidence, not generic API_KEY/JWT_SECRET placeholders",
        "plan reflects the real web/worker service split",
      ],
      ["tester_2026_06_11", "deployment_grounding", "scope_policy"],
    ),
    fixture(
      "artifacts_second_prompt_always_visible_terminal_state",
      "artifacts",
      "analyst",
      "Every Artifact Builder prompt ends in a visible artifact, error card, or timeout notice.",
      [
        "failed POSTs render an error card with retry",
        "artifact list refetches after every attempt",
        "second and later prompts never silently no-op",
      ],
      ["tester_2026_06_11", "artifact_terminal_feedback"],
    ),
    fixture(
      "app_solo_launch_failure_durable_and_recoverable",
      "app_solo",
      "engineer",
      "A failed App Solo launch leaves evidence and offers retry.",
      [
        "launch failure surfaces provider, HTTP status, and server detail",
        "an episodic memory document records the failed launch",
        "retry and retry-with-auto actions are offered",
      ],
      ["tester_2026_06_11", "app_solo_launch", "failure_memory"],
    ),
    fixture(
      "workbench_upload_feature_preserves_safe_files_and_rejects_traversal",
      "workbench",
      "engineer",
      "Upload single files, folders, and a zip containing a traversal entry.",
      [
        "single files, folders, and zip entries are written with preserved safe paths",
        "path traversal and absolute paths are rejected with visible skip reasons",
        "upload events make written and skipped files visible to the next run",
      ],
      ["tester_2026_06_11", "upload_mounting", "zip_safety"],
    ),
  ];
}

function fixture(
  id: string,
  surface: RuntimeAcceptanceSurface,
  ownerSeat: AgentRole,
  objective: string,
  passCriteria: string[],
  regressionTags: string[],
): RuntimeAcceptanceEvalFixture {
  return {
    id,
    surface,
    ownerSeat,
    objective,
    passCriteria,
    regressionTags,
    requires: ["memory_log", "trace_replay"],
  };
}

export function buildRuntimeAcceptanceEvalSuite(input?: {
  actuals?: RuntimeAcceptanceActuals;
  version?: string;
  previousScore?: number;
  fixtureIds?: string[];
}): EvalSuiteInput {
  const fixtureIds = input?.fixtureIds ? new Set(input.fixtureIds) : undefined;
  const fixtures = buildRuntimeAcceptanceEvalFixtures()
    .filter((item) => !fixtureIds || fixtureIds.has(item.id));
  return {
    subjectType: "seat",
    subjectId: "trent-runtime",
    version: input?.version ?? "runtime-v1",
    previousScore: input?.previousScore,
    fixtures: fixtures.map((item): EvalFixture => ({
      id: item.id,
      rubricId: `${item.surface}:${item.ownerSeat}`,
      input: {
        objective: item.objective,
        surface: item.surface,
        ownerSeat: item.ownerSeat,
        requires: item.requires,
      },
      actual: input?.actuals?.[item.id] ?? { text: "", toolCalls: [] },
      graders: [
        { type: "contains", weight: 0.7, values: item.passCriteria },
        { type: "tool_call", weight: 0.3, required: requiredToolCalls(item) },
      ],
    })),
  };
}

export function buildRuntimeAcceptancePassingActuals(
  fixtures: RuntimeAcceptanceEvalFixture[] = buildRuntimeAcceptanceEvalFixtures(),
): RuntimeAcceptanceActuals {
  return Object.fromEntries(
    fixtures.map((item) => [
      item.id,
      {
        text: item.passCriteria.join(" "),
        toolCalls: requiredToolCalls(item),
        state: { surface: item.surface, ownerSeat: item.ownerSeat, smoke: true },
      },
    ]),
  );
}

export function buildRuntimeAcceptanceActualsTemplate(
  fixtures: RuntimeAcceptanceEvalFixture[] = buildRuntimeAcceptanceEvalFixtures(),
): RuntimeAcceptanceActuals {
  return Object.fromEntries(
    fixtures.map((item) => [
      item.id,
      {
        text: "",
        toolCalls: requiredToolCalls(item),
        state: {
          surface: item.surface,
          ownerSeat: item.ownerSeat,
          result: "pending",
        },
      },
    ]),
  );
}

export function filterRuntimeAcceptanceFixturesByTag(
  tag: string,
  fixtures: RuntimeAcceptanceEvalFixture[] = buildRuntimeAcceptanceEvalFixtures(),
): RuntimeAcceptanceEvalFixture[] {
  return fixtures.filter((fixture) => fixture.regressionTags.includes(tag));
}

function requiredToolCalls(item: RuntimeAcceptanceEvalFixture): string[] {
  if (item.surface === "workbench") return ["workbench.verify"];
  if (item.surface === "app_solo") return ["workbench.session"];
  if (item.surface === "agent_mission") return ["agent_mission.run"];
  if (item.surface === "command" || item.surface === "orchestrator") return ["orchestrator.run"];
  return ["artifact.record"];
}
