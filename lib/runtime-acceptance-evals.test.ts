import { describe, expect, it } from "vitest";
import { runEvalSuite } from "@/lib/eval-harness";
import {
  buildRuntimeAcceptancePassingActuals,
  buildRuntimeAcceptanceEvalFixtures,
  buildRuntimeAcceptanceEvalSuite,
} from "@/lib/runtime-acceptance-evals";

describe("runtime acceptance eval fixtures", () => {
  it("covers the Workbench, App Solo, Command, routing, and artifact regressions from the runtime plan", () => {
    const fixtures = buildRuntimeAcceptanceEvalFixtures();
    const ids = fixtures.map((fixture) => fixture.id);

    expect(ids).toEqual(expect.arrayContaining([
      "workbench_notes_app_requires_install_build_typecheck_render",
      "workbench_placeholder_screenshot_fails",
      "workbench_blank_react_root_fails",
      "workbench_console_error_fails",
      "workbench_failed_install_surfaces_repair_feedback",
      "workbench_repair_loop_reports_max_attempt_failure",
      "app_solo_starts_and_streams_workbench_run",
      "command_reconnect_snapshot_shows_reports_and_ceo_summary",
      "ceo_routes_specialist_tools_to_right_seats",
      "content_mission_approval_packet_has_external_action_ledger",
      "agent_mission_researches_viral_ideas_and_proposes_angles",
      "agent_mission_creates_content_packet_without_publish",
      "agent_mission_requires_ceo_approval_before_publish",
      "agent_mission_requires_finance_approval_before_ad_spend",
      "agent_mission_routes_angry_comment_to_support_escalation",
      "agent_mission_routes_buyer_dm_to_sales",
      "agent_mission_research_make_publish_reply_ads_report_e2e",
      "agent_mission_ceo_report_includes_artifacts_costs_metrics_next_actions",
      "same_seat_delegation_skipped_and_logged",
      "artifacts_include_agent_attribution",
    ]));
  });

  it("assigns measurable pass criteria and owners to every fixture", () => {
    const fixtures = buildRuntimeAcceptanceEvalFixtures();

    expect(fixtures.length).toBeGreaterThanOrEqual(19);
    for (const fixture of fixtures) {
      expect(fixture.ownerSeat).toMatch(/^(ceo|engineer|growth|content|support|finance|analyst|escalation|sales)$/);
      expect(fixture.surface).toMatch(/^(workbench|app_solo|command|orchestrator|artifacts|agent_mission)$/);
      expect(fixture.passCriteria.length).toBeGreaterThanOrEqual(2);
      expect(fixture.regressionTags.length).toBeGreaterThanOrEqual(1);
      expect(fixture.requires).toEqual(expect.arrayContaining(["memory_log"]));
    }
  });

  it("can be executed by the shared eval harness", async () => {
    const suite = buildRuntimeAcceptanceEvalSuite({
      actuals: {
        workbench_notes_app_requires_install_build_typecheck_render: {
          text: "install exits 0 build/typecheck pass preview DOM contains meaningful notes UI real screenshot captured",
          toolCalls: ["workbench.verify"],
        },
      },
    });

    const result = await runEvalSuite(suite);

    expect(result.subjectType).toBe("seat");
    expect(result.subjectId).toBe("trent-runtime");
    expect(result.fixtures.find((fixture) => fixture.id === "workbench_notes_app_requires_install_build_typecheck_render")?.passed).toBe(true);
  });

  it("can generate a deterministic passing actuals bundle for CI smoke runs", async () => {
    const suite = buildRuntimeAcceptanceEvalSuite({
      actuals: buildRuntimeAcceptancePassingActuals(),
    });

    const result = await runEvalSuite(suite);

    expect(result.score).toBe(1);
    expect(result.fixtures.every((fixture) => fixture.passed)).toBe(true);
  });
});
