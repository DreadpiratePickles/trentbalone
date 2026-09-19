/**
 * [D1] goldens are the suites (plan decision 4), and a seat can be gated at last.
 *
 * Three things are asserted here, all offline:
 *   1. a captured failure becomes a fixture — the sanitised objective as the prompt, a
 *      deterministic grader that fails when the run reproduces the captured failure tag, and one
 *      rubric line carrying the reason to the judge;
 *   2. the human gate is the status on the file: a quarantined golden is not in any suite, a
 *      promoted one is, a rejected one never comes back;
 *   3. a seat resolves its suite by SEAT ID — from its promoted goldens and from the skills the
 *      app's `SLOT_ENVIRONMENTS` gives it — and when it has none, the block reason names the seat
 *      and both golden counts instead of the bare `no_suite` every seat used to get.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GOLDEN_FIXTURE_PREFIX,
  REPRODUCED_TAGS_STATE_KEY,
  createSeatSuites,
  goldenActuals,
  goldenFixture,
  goldenSeats,
  listGoldens,
  promotedGoldens,
  seatSkills,
  setGoldenStatus,
  splitSuite,
  suiteFromGoldens,
  type ActualsOutput,
  type StoredGolden,
} from "./index.js";

let dir: string;
let skillsRoot: string;

const CAPTURE = {
  id: "orcgolden_1",
  runId: "run_7",
  companyId: "trent-local",
  objective: "Reconcile the September ledger and flag any charge over 5000 cents",
  reason: "run_failed: the finance step never verified the totals",
  status: "quarantined" as const,
  trajectoryFailureTags: ["trajectory_terminal_event_emitted"],
  capturedAt: "2026-09-18T10:00:00.000Z",
};

function writeCapture(golden: Partial<StoredGolden> & { runId: string }): StoredGolden {
  const full = { ...CAPTURE, ...golden } as StoredGolden;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `golden-${full.runId}.json`), `${JSON.stringify(full, null, 2)}\n`, "utf8");
  return full;
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-d1-goldens-"));
  dir = path.join(root, "goldens");
  skillsRoot = path.join(root, "skills");
  fs.mkdirSync(path.join(skillsRoot, "reconciliation", "evals"), { recursive: true });
  fs.writeFileSync(
    path.join(skillsRoot, "reconciliation", "evals", "evals.json"),
    JSON.stringify({
      skill_name: "reconciliation",
      evals: [{ id: 1, prompt: "Close the month", assertions: ["States which accounts did not reconcile."] }],
    }),
    "utf8",
  );
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe("[D1] a captured failure becomes a fixture", () => {
  it("carries the sanitised objective, the failure-tag check and one rubric line from the reason", () => {
    const fixture = goldenFixture(writeCapture({ runId: "run_7" }));

    expect(fixture.id).toBe(`${GOLDEN_FIXTURE_PREFIX}${CAPTURE.id}`);
    expect(fixture.prompt).toBe(CAPTURE.objective);

    const state = fixture.graders.find((g) => g.type === "state_check");
    expect(state, "a golden carries the deterministic failure-tag check").toBeDefined();
    expect((state as { expect: Record<string, unknown> }).expect[REPRODUCED_TAGS_STATE_KEY]).toEqual([]);

    const rubrics = fixture.graders.filter((g) => g.type === "llm_rubric") as Array<{ rubric: string }>;
    expect(rubrics).toHaveLength(1);
    expect(rubrics[0]!.rubric).toContain(CAPTURE.reason);
  });

  it("maps the assertions and mechanical fields a capture already carries", () => {
    const fixture = goldenFixture(
      writeCapture({
        runId: "run_8",
        id: "orcgolden_8",
        assertions: ["Names the reconciling account."],
        contains: ["variance"],
        forbidden_tools: ["terminal"],
      }),
    );
    expect(fixture.graders.filter((g) => g.type === "contains")).toHaveLength(1);
    expect(fixture.graders.filter((g) => g.type === "tool_call")).toHaveLength(1);
    expect((fixture.graders.filter((g) => g.type === "llm_rubric") as Array<{ rubric: string }>).map((g) => g.rubric)).toContain(
      "Names the reconciling account.",
    );
  });

  it("the failure-tag grader fails deterministically when the run reproduces the captured tag", async () => {
    const golden = writeCapture({ runId: "run_7" });
    const reproduced: ActualsOutput = { text: "done", costCents: 1, state: { failureTags: ["trajectory_terminal_event_emitted"] } };
    const clean: ActualsOutput = { text: "done", costCents: 1, state: { failureTags: ["trajectory_no_duplicate_work"] } };

    const runner = goldenActuals(async ({ fixtureId }) => (fixtureId.endsWith("clean") ? clean : reproduced), [golden]);
    const out = await runner({ systemPrompt: "s", prompt: CAPTURE.objective, fixtureId: `${GOLDEN_FIXTURE_PREFIX}${CAPTURE.id}` });
    expect(out.state?.[REPRODUCED_TAGS_STATE_KEY]).toEqual(["trajectory_terminal_event_emitted"]);

    const other = goldenActuals(async () => clean, [golden]);
    const ok = await other({ systemPrompt: "s", prompt: CAPTURE.objective, fixtureId: `${GOLDEN_FIXTURE_PREFIX}${CAPTURE.id}` });
    expect(ok.state?.[REPRODUCED_TAGS_STATE_KEY]).toEqual([]);
  });

  it("a runner that cannot observe a trajectory reports no reproduced tag rather than none at all", async () => {
    const golden = writeCapture({ runId: "run_7" });
    const runner = goldenActuals(async () => ({ text: "done", costCents: 0 }), [golden]);
    const out = await runner({ systemPrompt: "s", prompt: "x", fixtureId: `${GOLDEN_FIXTURE_PREFIX}${CAPTURE.id}` });
    expect(out.state?.[REPRODUCED_TAGS_STATE_KEY]).toEqual([]);
  });
});

describe("[D1] promotion is the human gate on a golden", () => {
  it("only a promoted golden enters a suite", async () => {
    writeCapture({ runId: "run_7" });
    expect(promotedGoldens(await listGoldens(dir))).toHaveLength(0);

    await setGoldenStatus(dir, CAPTURE.id, "promoted", "2026-09-18T11:00:00.000Z");
    const promoted = promotedGoldens(await listGoldens(dir));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.promotedAt).toBe("2026-09-18T11:00:00.000Z");

    await setGoldenStatus(dir, CAPTURE.id, "rejected", "2026-09-18T12:00:00.000Z");
    expect(promotedGoldens(await listGoldens(dir))).toHaveLength(0);
  });

  it("a suite of goldens splits into optimise and holdout the same way every machine does", () => {
    const goldens = Array.from({ length: 12 }, (_, i) =>
      writeCapture({ runId: `run_${i}`, id: `orcgolden_${i}`, status: "promoted" }),
    );
    const suite = suiteFromGoldens("finance", goldens);
    expect(suite).toBeDefined();
    expect(suite!.fixtures).toHaveLength(12);
    const split = splitSuite(suite!);
    expect(split.holdout.length).toBeGreaterThan(0);
    expect(split.optimise.length).toBeGreaterThan(0);
    expect(splitSuite(suiteFromGoldens("finance", goldens)!).holdout.map((f) => f.id)).toEqual(split.holdout.map((f) => f.id));
  });

  it("the suite version moves when a golden is promoted, so a baseline is never reused across suites", () => {
    const a = suiteFromGoldens("finance", [writeCapture({ runId: "run_1", id: "g1", status: "promoted" })]);
    const b = suiteFromGoldens("finance", [
      writeCapture({ runId: "run_1", id: "g1", status: "promoted" }),
      writeCapture({ runId: "run_2", id: "g2", status: "promoted" }),
    ]);
    expect(a!.version).not.toBe(b!.version);
  });
});

describe("[D1] a golden belongs to the seats that ran it", () => {
  it("resolves the seats from the run's traces, and an explicit list on the capture wins", () => {
    const golden = writeCapture({ runId: "run_7" });
    const rolesByRun = new Map([["run_7", ["finance", "escalation"]]]);
    expect([...goldenSeats(golden, rolesByRun)]).toEqual(["finance", "escalation"]);
    expect([...goldenSeats({ ...golden, seats: ["sales"] }, rolesByRun)]).toEqual(["sales"]);
    expect([...goldenSeats(golden, new Map())]).toEqual([]);
  });
});

describe("[D1] a seat resolves a suite by its seat id", () => {
  const empty: StoredGolden[] = [];

  it("a seat with promoted goldens is gateable, and the seat's skills come in with them", async () => {
    const golden = writeCapture({ runId: "run_7", status: "promoted" });
    const suites = createSeatSuites({
      skillsRoot,
      seats: ["finance"],
      skillsFor: (agentId) => (agentId === "finance" ? ["reconciliation"] : []),
      goldensFor: (agentId) => (agentId === "finance" ? [golden] : empty),
    });

    const suite = await suites.suiteFor("finance");
    expect(suite, "the seat id resolved a suite").toBeDefined();
    expect(suite!.id).toBe("finance");
    expect(suite!.fixtures.map((f) => f.id)).toContain(`${GOLDEN_FIXTURE_PREFIX}${CAPTURE.id}`);
    expect(suite!.fixtures.some((f) => f.id.startsWith("reconciliation:"))).toBe(true);
  });

  it("a seat with no promoted golden has no suite, and the reason names the seat and both counts", async () => {
    const quarantined = writeCapture({ runId: "run_7" });
    const suites = createSeatSuites({
      skillsRoot,
      seats: ["finance"],
      skillsFor: () => [],
      goldensFor: () => [quarantined, { ...quarantined, id: "orcgolden_2" }],
    });

    expect(await suites.suiteFor("finance")).toBeUndefined();
    const reason = await suites.noSuiteReason("finance");
    expect(reason).toContain("finance");
    expect(reason).toContain("0 promoted");
    expect(reason).toContain("2 quarantined");
  });

  it("a catalog specialist keeps the existing skills path", async () => {
    const suites = createSeatSuites({
      skillsRoot,
      seats: ["finance"],
      skillsFor: (agentId) => (agentId === "fin-ledger" ? ["reconciliation"] : []),
      goldensFor: () => empty,
    });
    const suite = await suites.suiteFor("fin-ledger");
    expect(suite?.fixtures.map((f) => f.id)).toEqual(["reconciliation:1"]);
  });
});

describe("[D1] the goldens directory is frozen against the loop that is graded by it", () => {
  it("[D0] gate 1 already covers `<profile>/goldens`, which is now a suite", async () => {
    const { createFrozenSurface } = await import("./frozen-surface.js");
    const profileDir = path.dirname(dir);
    const surface = createFrozenSurface({ profileDir, blocks: [] });
    const violation = surface.violationFor({ path: path.join(dir, "golden-run_7.json") });
    expect(violation?.frozenClass).toBe("golden");
    expect(violation?.reason).toContain("frozen");
  });
});

describe("[D1] the seat's skills are the application's", () => {
  it("reads SLOT_ENVIRONMENTS rather than the catalog, which holds no seat id", async () => {
    const { SLOT_ENVIRONMENTS } = await import("@/lib/agent-catalog");
    for (const role of Object.keys(SLOT_ENVIRONMENTS)) {
      expect([...(await seatSkills(role))], role).toEqual([...(SLOT_ENVIRONMENTS[role as "sales"].skills ?? [])]);
    }
    expect(await seatSkills("eng-ai-engineer")).toEqual([]);
  });
});
