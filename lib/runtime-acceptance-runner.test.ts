import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runRuntimeAcceptanceEvalCommand } from "@/lib/runtime-acceptance-runner";

describe("runtime acceptance eval runner", () => {
  it("fails closed without actual runtime evidence", async () => {
    const result = await runRuntimeAcceptanceEvalCommand(["--threshold", "0.8"], { write: async () => {} });

    expect(result.exitCode).toBe(1);
    expect(result.result.score).toBeLessThan(0.8);
  });

  it("passes deterministic smoke mode and writes JSON output when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trent-runtime-evals-"));
    const out = join(dir, "result.json");

    const result = await runRuntimeAcceptanceEvalCommand(["--smoke", "--threshold", "1", "--out", out], { write: async () => {} });
    const saved = JSON.parse(await readFile(out, "utf8")) as { score: number };

    expect(result.exitCode).toBe(0);
    expect(result.result.score).toBe(1);
    expect(saved.score).toBe(1);
  });

  it("loads actuals from a JSON evidence file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trent-runtime-evals-"));
    const actualsPath = join(dir, "actuals.json");
    await writeFile(actualsPath, JSON.stringify({
      workbench_notes_app_requires_install_build_typecheck_render: {
        text: "install exits 0 build/typecheck pass preview DOM contains meaningful notes UI real screenshot captured",
        toolCalls: ["workbench.verify"],
      },
    }));

    const result = await runRuntimeAcceptanceEvalCommand(["--actuals", actualsPath, "--threshold", "0.01"], { write: async () => {} });

    expect(result.exitCode).toBe(0);
    expect(result.result.fixtures.some((fixture) => fixture.passed)).toBe(true);
  });

  it("runs only the 2026-06-11 tester fixtures when requested", async () => {
    const result = await runRuntimeAcceptanceEvalCommand(["--tester-2026-06-11", "--smoke", "--threshold", "1"], { write: async () => {} });

    expect(result.exitCode).toBe(0);
    expect(result.result.fixtures).toHaveLength(12);
    expect(result.result.fixtures.map((fixture) => fixture.id)).toEqual([
      "command_source_coverage_required_for_doc_grounded_audits",
      "command_ui_converges_after_stream_loss",
      "command_campaign_prompt_always_returns_visible_terminal_state",
      "workbench_analysis_prompt_stays_read_only",
      "workbench_landing_page_uses_brand_and_marketing_sources",
      "workbench_command_recovery_does_not_repair_app",
      "workbench_prose_lines_never_executed",
      "workbench_research_reads_uploaded_files",
      "workbench_deployment_plan_grounded_in_repo_config",
      "artifacts_second_prompt_always_visible_terminal_state",
      "app_solo_launch_failure_durable_and_recoverable",
      "workbench_upload_feature_preserves_safe_files_and_rejects_traversal",
    ]);
  });

  it("writes a fillable actuals template for the selected tester fixtures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trent-runtime-evals-"));
    const templatePath = join(dir, "tester-actuals.json");

    const result = await runRuntimeAcceptanceEvalCommand([
      "--tester-2026-06-11",
      "--write-actuals-template",
      templatePath,
      "--template-only",
    ], { write: async () => {} });
    const template = JSON.parse(await readFile(templatePath, "utf8")) as Record<string, {
      text: string;
      toolCalls: string[];
      state: { surface: string; ownerSeat: string; result: string };
    }>;

    expect(result.exitCode).toBe(0);
    expect(Object.keys(template)).toHaveLength(12);
    expect(template.command_source_coverage_required_for_doc_grounded_audits).toEqual({
      text: "",
      toolCalls: ["orchestrator.run"],
      state: {
        surface: "command",
        ownerSeat: "ceo",
        result: "pending",
      },
    });
  });

  it("runs the real AgentMission content/social/ads e2e fixture", async () => {
    const result = await runRuntimeAcceptanceEvalCommand(["--agent-mission-e2e", "--threshold", "1"], { write: async () => {} });

    expect(result.exitCode).toBe(0);
    expect(result.result.score).toBe(1);
    expect(result.result.fixtures.map((fixture) => fixture.id)).toEqual([
      "agent_mission_research_make_publish_reply_ads_report_e2e",
    ]);
    expect(result.result.fixtures[0].passed).toBe(true);
  });
});
