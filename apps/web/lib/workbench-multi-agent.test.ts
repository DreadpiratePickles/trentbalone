import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planToWaves, type BuildPlanFile } from "@/lib/workbench-build-graph";
import { planBuild, buildEditorPrompt, type PlannerCall } from "@/lib/workbench-build-planner";
import { runEditorWaves, type EditorResult } from "@/lib/workbench-build-editors";
import { runPlannedBuild, shouldUseMultiAgentPlan } from "@/lib/workbench-build-multi";
import { getWorkbenchTemplate } from "@/lib/workbench-templates";

const f = (path: string, dependsOn: string[] = []): BuildPlanFile => ({ path, intent: `build ${path}`, dependsOn });

describe("planToWaves", () => {
  it("puts independent files in a single wave", () => {
    const r = planToWaves([f("a"), f("b"), f("c")]);
    expect(r.waves).toEqual([["a", "b", "c"]]);
    expect(r.hasCycle).toBe(false);
  });

  it("orders a linear dependency chain into successive waves", () => {
    const r = planToWaves([f("c", ["b"]), f("b", ["a"]), f("a")]);
    expect(r.waves).toEqual([["a"], ["b"], ["c"]]);
  });

  it("layers a diamond correctly", () => {
    // d depends on b,c; b,c depend on a.
    const r = planToWaves([f("d", ["b", "c"]), f("b", ["a"]), f("c", ["a"]), f("a")]);
    expect(r.waves).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("treats deps outside the plan as pre-existing and records them", () => {
    const r = planToWaves([f("page.tsx", ["src/lib/db.ts", "comp.tsx"]), f("comp.tsx")]);
    expect(r.externalDeps).toContain("src/lib/db.ts");
    // page depends only on comp (in-plan); comp has no deps → comp first.
    expect(r.waves[0]).toContain("comp.tsx");
    expect(r.waves[r.waves.length - 1]).toContain("page.tsx");
  });

  it("breaks a cycle instead of looping forever", () => {
    const r = planToWaves([f("a", ["b"]), f("b", ["a"])]);
    expect(r.hasCycle).toBe(true);
    expect(r.waves.flat().sort()).toEqual(["a", "b"]);
  });
});

describe("planBuild", () => {
  const template = getWorkbenchTemplate("fullstack-next");

  it("parses, dedupes, drops self-edges, and caps the plan", async () => {
    const callPlanner: PlannerCall = async <T,>(_m: string, _s: string, _u: string, schema: z.ZodType<T>) => {
      const raw = {
        title: "Habit tracker",
        decisions: "User has many Habits; Habit has title + completions.",
        files: [
          { path: "./src/app/page.tsx", intent: "home", dependsOn: ["src/app/page.tsx", "src/lib/habits.ts"] },
          { path: "src/app/page.tsx", intent: "dupe should be dropped", dependsOn: [] },
          { path: "src/lib/habits.ts", intent: "habit data access", dependsOn: [] },
        ],
      };
      return { data: schema.parse(raw) };
    };

    const plan = await planBuild({ objective: "habit tracker", template, projectContext: "", callPlanner });
    expect(plan.title).toBe("Habit tracker");
    expect(plan.files).toHaveLength(2); // dupe removed
    const page = plan.files.find((file) => file.path === "src/app/page.tsx")!;
    expect(page.dependsOn).toEqual(["src/lib/habits.ts"]); // self-edge + ./ normalised away
  });

  it("rejects malformed planner output", async () => {
    const bad: PlannerCall = async <T,>(_m: string, _s: string, _u: string, schema: z.ZodType<T>) => {
      return { data: schema.parse({ title: "x", files: [] }) }; // empty files violates .min(1)
    };
    await expect(planBuild({ objective: "x", template, projectContext: "", callPlanner: bad })).rejects.toThrow();
  });
});

describe("buildEditorPrompt", () => {
  it("scopes the editor to one file and lists siblings without their content", () => {
    const plan = { title: "T", decisions: "shared types here", files: [f("a.ts"), f("b.ts")] };
    const prompt = buildEditorPrompt({ plan, file: plan.files[0] });
    expect(prompt).toContain("a.ts");
    expect(prompt).toContain("b.ts: build b.ts");
    expect(prompt).toContain("shared types here");
    expect(prompt).toMatch(/single <boltAction type="file" filePath="a\.ts">/);
  });
});

describe("runEditorWaves", () => {
  it("runs a wave in parallel under the concurrency cap, waves sequentially", async () => {
    const waves = [["a", "b", "c", "d"], ["e"]];
    const files = waves.flat().map((p) => f(p));
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const editFile = async (file: BuildPlanFile): Promise<EditorResult> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      order.push(file.path);
      return { path: file.path, ok: true, detail: "ok" };
    };
    const { results, aborted } = await runEditorWaves({ waves, files, editFile, concurrency: 2 });
    expect(aborted).toBe(false);
    expect(results).toHaveLength(5);
    expect(maxActive).toBeLessThanOrEqual(2);
    // "e" (wave 2) must run after all of wave 1.
    expect(order.indexOf("e")).toBe(4);
  });

  it("collects failures and can abort once maxFailures is hit", async () => {
    const waves = [["a"], ["b"], ["c"]];
    const files = waves.flat().map((p) => f(p));
    const editFile = async (file: BuildPlanFile): Promise<EditorResult> =>
      ({ path: file.path, ok: file.path !== "a", detail: file.path === "a" ? "boom" : "ok" });
    const { results, aborted } = await runEditorWaves({ waves, files, editFile, maxFailures: 1 });
    expect(aborted).toBe(true);
    expect(results.some((r) => !r.ok)).toBe(true);
    expect(results.length).toBe(1); // aborted after wave 1
  });

  it("turns a thrown editor into a failed result", async () => {
    const { results } = await runEditorWaves({
      waves: [["a"]],
      files: [f("a")],
      editFile: async () => { throw new Error("model exploded"); },
    });
    expect(results[0]).toMatchObject({ path: "a", ok: false });
    expect(results[0].detail).toContain("model exploded");
  });
});

describe("runPlannedBuild (end-to-end with fakes)", () => {
  it("plans, schedules waves, and writes every file", async () => {
    const template = getWorkbenchTemplate("fullstack-next");
    const callPlanner: PlannerCall = async <T,>(_m: string, _s: string, _u: string, schema: z.ZodType<T>) => ({
      data: schema.parse({
        title: "Notes app",
        decisions: "Note { id, body }",
        files: [
          { path: "src/app/page.tsx", intent: "list notes", dependsOn: ["src/lib/notes.ts", "src/components/note.tsx"] },
          { path: "src/components/note.tsx", intent: "note card", dependsOn: [] },
          { path: "src/lib/notes.ts", intent: "data access", dependsOn: [] },
        ],
      }),
    });
    const writtenOrder: string[] = [];
    const result = await runPlannedBuild({
      objective: "notes app with accounts",
      template,
      projectContext: "",
      callPlanner,
      editFile: async (file) => {
        writtenOrder.push(file.path);
        return { path: file.path, ok: true, detail: "wrote", bytes: 100 };
      },
    });
    expect(result.written.sort()).toEqual(["src/app/page.tsx", "src/components/note.tsx", "src/lib/notes.ts"]);
    expect(result.failed).toHaveLength(0);
    // page.tsx depends on the other two, so it is written last.
    expect(writtenOrder.indexOf("src/app/page.tsx")).toBe(2);
  });
});

describe("shouldUseMultiAgentPlan", () => {
  it("uses the multi-agent path only for larger plans", () => {
    expect(shouldUseMultiAgentPlan(3)).toBe(false);
    expect(shouldUseMultiAgentPlan(6)).toBe(true);
    expect(shouldUseMultiAgentPlan(12)).toBe(true);
  });
});
