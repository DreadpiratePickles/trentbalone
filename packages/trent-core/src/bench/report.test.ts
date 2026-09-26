/**
 * [C16] The report's arithmetic, on hand-built attempts whose answers are worked out in the comments:
 * pass@1 (a task's first attempt), pass^3 (all three attempts of a task, and a task missing an attempt does
 * not count), medians in whole milliseconds, cost per successful task in integer micro-cents rounded up once,
 * and the three pre-registered targets.
 */
import { describe, expect, it } from "vitest";
import { buildReport, renderReport, type ReportMeta } from "./report.js";
import type { HarnessId, TaskClass, TaskRun } from "./types.js";

function attempt(harness: HarnessId, taskId: string, n: number, passed: boolean, extra: Partial<TaskRun> = {}): TaskRun {
  const taskClass: TaskClass = taskId.startsWith("g") ? "guard" : "booking";
  return {
    taskId, taskClass, harness, attempt: n, passed, status: "completed", wallMs: 1000, ttftMs: 100, ledgerCents: 1, microCents: 100_000,
    tokens: { input: 1000, output: 50, cachedInput: 0 }, unpriced: false,
    grade: { passed, score: passed ? 1 : 0, checks: [], failureTags: [] },
    ...extra,
  };
}

const META: ReportMeta = {
  suite: "smb-20", fingerprint: "0123456789abcdef", model: "gemini-3.5-flash-lite", runsPerTask: 3, harnesses: ["trent-solo", "hermes", "trent-fleet"],
  hermes: { version: "Hermes Agent v0.21.3", source: "hermes --version" }, startedAt: "2026-09-26T10:00:00.000Z", finishedAt: "2026-09-26T11:00:00.000Z",
};

// trent-solo: b1 passes 3/3; b2 passes only its first; g1 fails its first and passes the other two.
const SOLO: TaskRun[] = [
  attempt("trent-solo", "b1", 1, true, { ttftMs: 100, microCents: 85_000 }),
  attempt("trent-solo", "b1", 2, true, { ttftMs: 300, microCents: 86_000 }),
  attempt("trent-solo", "b1", 3, true, { ttftMs: 200, microCents: 90_001 }),
  attempt("trent-solo", "b2", 1, true, { ttftMs: null, microCents: 0 }),
  attempt("trent-solo", "b2", 2, false, { microCents: 10_000 }),
  attempt("trent-solo", "b2", 3, false, { microCents: 10_000 }),
  attempt("trent-solo", "g1", 1, false, { microCents: 20_000 }),
  attempt("trent-solo", "g1", 2, true, { microCents: 20_000 }),
  attempt("trent-solo", "g1", 3, true, { microCents: 20_000 }),
];
// hermes: only b1's first attempt passes; g1 has only two attempts recorded.
const HERMES: TaskRun[] = [
  attempt("hermes", "b1", 1, true), attempt("hermes", "b1", 2, false), attempt("hermes", "b1", 3, false),
  attempt("hermes", "b2", 1, false), attempt("hermes", "b2", 2, false), attempt("hermes", "b2", 3, false),
  attempt("hermes", "g1", 1, false), attempt("hermes", "g1", 2, true),
];
// the fleet: wins the guard class outright (1/1 against 0/1 and 0/1) and ties nowhere else.
const FLEET: TaskRun[] = [
  attempt("trent-fleet", "b1", 1, false), attempt("trent-fleet", "b2", 1, false), attempt("trent-fleet", "g1", 1, true),
];

describe("[C16] the bench report", () => {
  const report = buildReport([...SOLO, ...HERMES, ...FLEET], META);
  const solo = report.harnesses.find((h) => h.harness === "trent-solo")!;
  const hermes = report.harnesses.find((h) => h.harness === "hermes")!;
  const fleet = report.harnesses.find((h) => h.harness === "trent-fleet")!;

  it("counts pass@1 on first attempts and pass^3 only where all three attempts exist and passed", () => {
    expect(solo.passAt1).toEqual({ passed: 2, of: 3 });
    expect(solo.passHatK).toEqual({ k: 3, passed: 1, of: 3 });
    expect(hermes.passAt1).toEqual({ passed: 1, of: 3 });
    expect(hermes.passHatK).toEqual({ k: 3, passed: 0, of: 3 });
    expect(report.harnesses.map((h) => h.harness)).toEqual(["trent-solo", "hermes", "trent-fleet"]);
  });

  it("takes medians in whole milliseconds over the attempts that have one", () => {
    // ttft: 100, 300, 200 and five 100s (b2's first has none): sorted 100 x6, 200, 300 -> even count, middle 100 and 100.
    expect(solo.ttftMedianMs).toBe(100);
    expect(buildReport([attempt("hermes", "b1", 1, true, { ttftMs: 100 }), attempt("hermes", "b2", 1, true, { ttftMs: 201 })], META).harnesses[0]?.ttftMedianMs).toBe(150);
    expect(buildReport([attempt("hermes", "b1", 1, true, { ttftMs: null })], META).harnesses[0]?.ttftMedianMs).toBeNull();
    expect(solo.wall).toEqual({ totalMs: 9000, medianMs: 1000 });
  });

  it("divides every attempt's micro-cents by the successful attempts, rounding up once, and keeps money integer", () => {
    // 85,000 + 86,000 + 90,001 + 0 + 10,000 + 10,000 + 20,000 x3 = 341,001 over 6 successes = 56,833.5 -> 56,834.
    expect(solo.successes).toBe(6);
    expect(solo.cost).toEqual({ microCents: 341_001, ledgerCents: 9, microCentsPerSuccess: 56_834, unpriced: false });
    expect(buildReport([attempt("hermes", "b1", 1, false)], META).harnesses[0]?.cost.microCentsPerSuccess).toBeNull();
    for (const h of report.harnesses) for (const value of [h.cost.microCents, h.cost.ledgerCents, h.cost.microCentsPerSuccess ?? 0]) expect(Number.isInteger(value)).toBe(true);
  });

  it("judges the three pre-registered targets", () => {
    expect(report.targets).toEqual([
      { id: "solo-pass-at-1-vs-hermes", holds: true, detail: "trent-solo 2/3 against hermes 1/3 on gemini-3.5-flash-lite" },
      { id: "flash-lite-cost-per-success", holds: true, detail: "trent-solo 0.056834 cents per successful task (target at most 0.5)" },
      { id: "fleet-wins-a-task-class", holds: true, detail: "trent-fleet wins guard" },
    ]);
    const other = buildReport([...SOLO, ...HERMES], { ...META, model: "qwen3.5:9b", harnesses: ["trent-solo", "hermes"] });
    expect(other.targets.map((t) => [t.id, t.holds])).toEqual([["solo-pass-at-1-vs-hermes", true], ["flash-lite-cost-per-success", null], ["fleet-wins-a-task-class", null]]);
    // Booking 1/2 against solo's 2/2, guard 0/1 against solo's 0/1: a tie is not a win.
    const tieFleet = [attempt("trent-fleet", "b1", 1, false), attempt("trent-fleet", "b2", 1, true), attempt("trent-fleet", "g1", 1, false)];
    const tie = buildReport([...SOLO, ...tieFleet], { ...META, harnesses: ["trent-solo", "trent-fleet"] });
    expect(tie.targets.find((t) => t.id === "fleet-wins-a-task-class")).toMatchObject({ holds: false, detail: "trent-fleet wins no task class" });
  });

  it("lists pass@1 by class and renders a table a person can read", () => {
    expect(fleet.byClass).toEqual({ booking: { passed: 0, of: 2 }, guard: { passed: 1, of: 1 } });
    const text = renderReport(report).join("\n");
    expect(text).toContain("smb-20 (fingerprint 0123456789abcdef) on gemini-3.5-flash-lite, 3 runs per task");
    expect(text).toContain("Hermes Agent v0.21.3 (hermes --version)");
    expect(text).toMatch(/trent-solo\s+2\/3 66\.6%\s+1\/3 33\.3%/);
    expect(text).toContain("holds  solo-pass-at-1-vs-hermes");
  });
});
