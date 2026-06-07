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
