/**
 * I.6 — the wrapper's mechanical graders overlay the app's rubric-only suites.
 * `apps/web` is read-only, so `<overlayRoot>/<skill>/evals/mechanical.json` is merged by the file
 * provider; the suite version changes with the overlay, so a baseline is never reused across it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUNDLED_MECHANICAL_OVERLAYS_DIR, executeGate, fileSuiteProvider, loadMechanicalOverlay, loadSkillSuite } from "./index.js";

const EVALS = {
  skill_name: "demo",
  evals: [
    { id: 1, prompt: "Plan a paid strategy for a B2B HR SaaS.", assertions: ["Recommends a budget split."] },
    { id: 2, prompt: "Which tool first?", assertions: ["Reads memory first."] },
  ],
};

let root: string;
let overlays: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-suites-"));
  overlays = fs.mkdtempSync(path.join(os.tmpdir(), "trent-overlays-"));
  fs.mkdirSync(path.join(root, "demo", "evals"), { recursive: true });
  fs.writeFileSync(path.join(root, "demo", "evals", "evals.json"), JSON.stringify(EVALS));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(overlays, { recursive: true, force: true });
});

function writeOverlay(body: unknown): void {
  fs.mkdirSync(path.join(overlays, "demo", "evals"), { recursive: true });
  fs.writeFileSync(path.join(overlays, "demo", "evals", "mechanical.json"), JSON.stringify(body));
}

describe("mechanical overlay (I.6)", () => {
  it("merges contains / required_tools / state_check graders from mechanical.json into the app's rubric fixtures", async () => {
    writeOverlay({
      skill_name: "demo",
      evals: [
        { id: 1, contains: ["linkedin"] },
        { id: 2, required_tools: ["memory:read"], state_check: { done: true } },
      ],
    });
    const suite = await fileSuiteProvider(root, () => ["demo"], { overlayRoot: overlays })("growth");
    expect(suite).toBeDefined();
    const first = suite!.fixtures.find((f) => f.id === "demo:1")!;
    expect(first.graders).toContainEqual({ type: "contains", weight: 1, values: ["linkedin"] });
    expect(first.graders).toContainEqual({ type: "llm_rubric", weight: 1, rubric: "Recommends a budget split." });
    const second = suite!.fixtures.find((f) => f.id === "demo:2")!;
    expect(second.graders).toContainEqual({ type: "tool_call", weight: 1, required: ["memory:read"], forbidden: [] });
    expect(second.graders).toContainEqual({ type: "state_check", weight: 1, expect: { done: true } });
  });

  it("the merged suite version differs from the bare suite's and changes when the overlay changes", async () => {
    const bare = (await fileSuiteProvider(root, () => ["demo"])("growth"))!;
    writeOverlay({ skill_name: "demo", evals: [{ id: 1, contains: ["linkedin"] }] });
    const v1 = (await fileSuiteProvider(root, () => ["demo"], { overlayRoot: overlays })("growth"))!;
    writeOverlay({ skill_name: "demo", evals: [{ id: 1, contains: ["linkedin", "google"] }] });
    const v2 = (await fileSuiteProvider(root, () => ["demo"], { overlayRoot: overlays })("growth"))!;
    expect(v1.version).not.toBe(bare.version);
    expect(v2.version).not.toBe(v1.version);
  });

  it("an overlay with a contains grader reaches stage 'deterministic' and blocks before any judge call", async () => {
    writeOverlay({ skill_name: "demo", evals: [{ id: 1, contains: ["linkedin"] }] });
    const suite = (await fileSuiteProvider(root, () => ["demo"], { overlayRoot: overlays })("growth"))!;
    let judgeCalls = 0;
    const verdict = await executeGate({
      candidate: { id: "c", kind: "skill", content: "CANDIDATE" },
      seatPrompt: "seat",
      suite,
      baseline: { score: 0.5, failureClusters: {} },
      actuals: async () => ({ text: "Use Meta only.", costCents: 1 }),
      judge: async () => {
        judgeCalls += 1;
        return { pass: true };
      },
    });
    expect(verdict.stage).toBe("deterministic");
    expect(verdict.blockedBy).toBe("deterministic_failure");
    expect(judgeCalls).toBe(0);
  });

  it("a malformed or absent overlay leaves the app's suite untouched", async () => {
    fs.mkdirSync(path.join(overlays, "demo", "evals"), { recursive: true });
    fs.writeFileSync(path.join(overlays, "demo", "evals", "mechanical.json"), "{not json");
    const suite = (await fileSuiteProvider(root, () => ["demo"], { overlayRoot: overlays })("growth"))!;
    expect(suite.fixtures.every((f) => f.graders.every((g) => g.type === "llm_rubric"))).toBe(true);
    expect(loadMechanicalOverlay(path.join(overlays, "nope.json"))).toBeUndefined();
  });

  it("ships a real overlay for the app's `ads` suite whose ids all exist in evals.json", () => {
    const overlay = loadMechanicalOverlay(path.join(BUNDLED_MECHANICAL_OVERLAYS_DIR, "ads", "evals", "mechanical.json"));
    expect(overlay?.skill_name).toBe("ads");
    expect(overlay!.evals.length).toBeGreaterThan(0);
    const app = loadSkillSuite(path.resolve(import.meta.dirname, "../../../../apps/web/.agents/skills/ads/evals/evals.json"));
    if (app === undefined) return; // the app checkout is not present in this environment
    const ids = new Set(app.fixtures.map((f) => f.id));
    for (const ev of overlay!.evals) expect(ids.has(`ads:${ev.id}`), `ads:${ev.id}`).toBe(true);
  });
});
