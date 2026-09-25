/**
 * [C2] Brain recall: what a seat is handed from `memory/`, `decisions/` and its OWN
 * `seats/<seat>/notes.md` when the objective is related, and the cheap on-disk index that makes
 * it affordable.
 *
 * The index under `<profile>/cache/brain-index/` is NOT authoritative: deleting it costs a rebuild
 * and nothing else. It is keyed on the brain's version — the git head when versioning is on, a
 * digest of the files' sizes and modification times when it is off — so an unchanged brain is
 * never re-read and a changed one is never served stale.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryAdapter } from "../tools/memory/index.js";
import { createBrain, type Brain, type BrainExec } from "./brain.js";
import { brainIndexDir, buildBrainIndex, loadBrainIndex, recallFromBrain } from "./brain-index.js";
import type { CalibratedEmbedFn } from "./lexical.js";
import { createFleetMemoryHook } from "./orchestrator-hook.js";
import { InMemoryFleetSource } from "./source.js";

let profileDir: string;
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-brain-index-")));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function brainWith(): Brain {
  const brain = createBrain({ profileDir, exec: noGit });
  brain.ensure();
  brain.recordDecision({
    title: "Churn is measured on self-serve cohorts",
    body: "Retention for self-serve subscriptions is reported monthly, not per contract.",
    writer: "human",
    date: "2026-09-10",
  });
  brain.appendNote({ text: "the invoice run reconciled 42 open invoices", writer: "finance", runId: "run-0" });
  brain.writeSeatNote({ seat: "growth", text: "paid acquisition is capped at 300 dollars per account", writer: "growth" });
  return brain;
}

describe("the brain index", () => {
  it("indexes memory, decisions and seat notes, and never the system files", () => {
    const brain = brainWith();
    const entries = buildBrainIndex(brain);
    const paths = entries.map((e) => e.path);
    expect(paths.some((p) => p.startsWith("decisions/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("memory/"))).toBe(true);
    expect(paths.some((p) => p === "seats/growth/notes.md")).toBe(true);
    expect(paths.some((p) => p.startsWith("system/"))).toBe(false);
  });

  it("caches on disk under the profile and rebuilds only when the brain changes", () => {
    const brain = brainWith();
    const first = loadBrainIndex({ profileDir, brain });
    expect(first.rebuilt).toBe(true);
    expect(brainIndexDir(profileDir)).toBe(path.join(profileDir, "cache", "brain-index"));
    expect(fs.existsSync(path.join(brainIndexDir(profileDir), "index.json"))).toBe(true);

    const second = loadBrainIndex({ profileDir, brain });
    expect(second.rebuilt).toBe(false);
    expect(second.version).toBe(first.version);
    expect(second.entries.length).toBe(first.entries.length);

    brain.recordDecision({ title: "The judge model family is separate", body: "the judge never grades its own family.", writer: "human" });
    const third = loadBrainIndex({ profileDir, brain });
    expect(third.rebuilt).toBe(true);
    expect(third.version).not.toBe(first.version);
    expect(third.entries.length).toBe(first.entries.length + 1);
  });

  it("recalls a related decision and stays silent on an unrelated objective", async () => {
    const brain = brainWith();
    const related = await recallFromBrain({ profileDir, brain, seat: "analyst", objective: "why is churn rising in the self-serve cohorts" });
    expect(related.block).toContain("Churn is measured on self-serve cohorts");
    expect(related.items.length).toBeGreaterThan(0);

    const unrelated = await recallFromBrain({ profileDir, brain, seat: "analyst", objective: "book a flight to Lisbon next Tuesday" });
    expect(unrelated.block).toBe("");
  });

  it("gives a seat its own notes and never another seat's", async () => {
    const brain = brainWith();
    const growth = await recallFromBrain({ profileDir, brain, seat: "growth", objective: "how much may paid acquisition spend per account" });
    expect(growth.block).toContain("paid acquisition is capped");

    const finance = await recallFromBrain({ profileDir, brain, seat: "finance", objective: "how much may paid acquisition spend per account" });
    expect(finance.block).not.toContain("paid acquisition is capped");
  });

  it("honours the recall character budget", async () => {
    const brain = brainWith();
    for (let i = 0; i < 20; i += 1) {
      brain.recordDecision({ title: `churn decision ${String(i)}`, body: `self-serve churn cohorts retention note ${String(i)} `.repeat(20), writer: "human" });
    }
    const result = await recallFromBrain({ profileDir, brain, seat: "analyst", objective: "self-serve churn cohorts retention", budgetChars: 600 });
    expect(result.block.length).toBeLessThanOrEqual(600);
    expect(result.dropped).toBeGreaterThan(0);
  });
});

/**
 * [P2-6] Measured on real documents (improve/docs-corpus.test.ts): gemini-embedding-001 puts a
 * question against a 1,200-character chunk at cosine 0.55-0.73, so a chunk that shares no word with
 * the question earns 0.6 x (c - 0.6) / 0.4 and needs c >= 0.68 to reach `recallMinScore`. Seven
 * answers the blend already ranked in its own top 8 — three of them FIRST — came back as nothing.
 * A chunk whose cosine clears the embedder's own calibrated floor is related on that evidence
 * alone, as a chunk whose TF-IDF alone reaches the minimum already is; the order is the blend's.
 */
describe("[P2-6] the embedder's own floor admits a chunk the blend scores under recallMinScore", () => {
  /** Vectors built to have exactly `cosine(text)` against the query, calibrated like the Gemini route. */
  const embedWith = (cosine: (text: string) => number): CalibratedEmbedFn =>
    Object.assign(
      async (texts: readonly string[]) =>
        texts.map((text, i) => {
          if (i === texts.length - 1) return [1, 0];
          const c = cosine(text);
          return [c, Math.sqrt(1 - c * c)];
        }),
      { vectorFloor: 0.6 },
    );
  // Shares no token with the decision, the note or the seat note: only the embedder can relate them.
  const objective = "how do we count customers who leave";

  it("recalls a chunk whose cosine clears the floor though its blended score is 0.06, and nothing at or under the floor", async () => {
    const brain = brainWith();
    const churn = (text: string): boolean => text.includes("Churn is measured on self-serve cohorts");
    const above = await recallFromBrain({ profileDir, brain, seat: "analyst", objective, embed: embedWith((t) => (churn(t) ? 0.64 : 0.4)) });
    expect(above.items.map((item) => item.title)).toEqual(["Churn is measured on self-serve cohorts"]);
    expect(above.items[0]!.score).toBeCloseTo(0.06, 6);

    const atFloor = await recallFromBrain({ profileDir, brain, seat: "analyst", objective, embed: embedWith((t) => (churn(t) ? 0.6 : 0.4)) });
    expect(atFloor.block).toBe("");
  });

  it("keeps the blend's order: a chunk over the minimum still outranks one the floor admitted", async () => {
    const brain = brainWith();
    const cosine = (t: string): number => (t.includes("Churn is measured") ? 0.64 : t.includes("42 open invoices") ? 0.9 : 0.4);
    const result = await recallFromBrain({ profileDir, brain, seat: "analyst", objective, embed: embedWith(cosine) });
    expect(result.items.map((item) => item.path.split("/")[0])).toEqual(["memory", "decisions"]);
    expect(result.items[0]!.score).toBeGreaterThanOrEqual(0.12);
  });
});

describe("a decision written in one run reaches the next run's prompt", () => {
  it("recalls it for a related objective", async () => {
    const source = new InMemoryFleetSource();
    const brain = createBrain({ profileDir, exec: noGit });
    brain.ensure();

    const runOne = createFleetMemoryHook({ source, profileDir, memory: createMemoryAdapter({ profileDir }), brain });
    const seatOne = runOne.wrapSeatModel(async () => ({}));
    runOne.runStarted({ runId: "r1", companyId: "co_1", objective: "decide how churn is measured" });
    await seatOne({ subtask: { id: "s1", seat: "ceo", objective: "decide how churn is measured" } });
    brain.recordDecision({
      title: "Churn is measured on self-serve cohorts",
      body: "Retention for self-serve subscriptions is reported monthly.",
      writer: "ceo",
      runId: "r1",
    });
    runOne.runFinished("r1");

    const runTwo = createFleetMemoryHook({ source, profileDir, memory: createMemoryAdapter({ profileDir }), brain });
    let prelude = "";
    const seatTwo = runTwo.wrapSeatModel(async (input: { subtask: { id: string; seat: string; objective?: string }; dynamicPrompt?: string }) => {
      prelude = input.dynamicPrompt ?? "";
      return {};
    });
    runTwo.runStarted({ runId: "r2", companyId: "co_1", objective: "report churn for the self-serve cohorts this month" });
    await seatTwo({ subtask: { id: "s2", seat: "analyst", objective: "report churn for the self-serve cohorts this month" } });

    expect(prelude).toContain("Churn is measured on self-serve cohorts");
  });
});
