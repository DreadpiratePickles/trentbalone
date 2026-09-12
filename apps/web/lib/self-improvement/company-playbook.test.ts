import { describe, expect, it } from "vitest";
import {
  buildPlaybookDelta,
  foldPlaybook,
  InMemoryCompanyPlaybookLog,
  playbookDeltasFromReflection,
  renderPlaybookBlock,
  selectDeltasToDemote,
} from "@/lib/self-improvement/company-playbook";

function delta(input: Partial<Parameters<typeof buildPlaybookDelta>[0]> = {}) {
  return buildPlaybookDelta({
    companyId: "co_1",
    kind: "add",
    topic: "outreach.tone",
    text: "Lead with the customer's metric, not ours.",
    now: "2026-06-12T00:00:00.000Z",
    ...input,
  });
}

describe("append-only log", () => {
  it("appends without mutating prior rows and lists oldest first", async () => {
    const log = new InMemoryCompanyPlaybookLog();
    const first = delta({ now: "2026-06-12T00:00:00.000Z" });
    await log.append(first);
    await log.append(delta({ topic: "deploys.window", text: "No deploys after 22:00.", now: "2026-06-12T01:00:00.000Z" }));

    const listed = await log.list("co_1");
    listed[0]!.text = "tampered";
    const relisted = await log.list("co_1");

    expect(relisted.map((entry) => entry.topic)).toEqual(["outreach.tone", "deploys.window"]);
    expect(relisted[0]!.text).toBe("Lead with the customer's metric, not ours.");
    expect(relisted[0]!.id).toBe(first.id);
  });

  it("is tenant-scoped", async () => {
    const log = new InMemoryCompanyPlaybookLog();
    await log.append(delta({ companyId: "co_1" }));
    await log.append(delta({ companyId: "co_2", topic: "other.topic" }));

    expect((await log.list("co_1")).map((entry) => entry.companyId)).toEqual(["co_1"]);
  });
});

describe("foldPlaybook (ACE: latest-wins per topic, never a rewrite)", () => {
  it("folds revisions latest-wins per topic", () => {
    const folded = foldPlaybook([
      delta({ now: "2026-06-12T00:00:00.000Z" }),
      delta({ kind: "revise", text: "Lead with their metric AND name the source.", now: "2026-06-12T02:00:00.000Z" }),
      delta({ topic: "deploys.window", text: "No deploys after 22:00.", now: "2026-06-12T01:00:00.000Z" }),
    ]);

    expect(folded.bullets).toHaveLength(2);
    expect(folded.bullets.find((bullet) => bullet.topic === "outreach.tone")?.text)
      .toBe("Lead with their metric AND name the source.");
  });

  it("a deprecate delta removes its topic; deprecated rows are skipped entirely", () => {
    const folded = foldPlaybook([
      delta({ now: "2026-06-12T00:00:00.000Z" }),
      delta({ kind: "deprecate", text: "", now: "2026-06-12T01:00:00.000Z" }),
      { ...delta({ topic: "ads.budget", text: "Cap daily ads at $50.", now: "2026-06-12T02:00:00.000Z" }), status: "deprecated" as const },
    ]);

    expect(folded.bullets).toEqual([]);
  });

  it("caps output by token budget, dropping older-changed bullets first", () => {
    const folded = foldPlaybook(
      [
        delta({ topic: "old.rule", text: "x".repeat(200), now: "2026-06-12T00:00:00.000Z" }),
        delta({ topic: "new.rule", text: "y".repeat(200), now: "2026-06-12T01:00:00.000Z" }),
      ],
      { tokenBudget: 60 },
    );

    expect(folded.truncated).toBe(true);
    expect(folded.bullets.map((bullet) => bullet.topic)).toEqual(["new.rule"]);
  });
});

describe("renderPlaybookBlock", () => {
  it("renders bullets and returns empty string for an empty playbook", () => {
    expect(renderPlaybookBlock(foldPlaybook([]))).toBe("");
    const block = renderPlaybookBlock(foldPlaybook([delta()]));
    expect(block).toContain("COMPANY PLAYBOOK");
    expect(block).toContain("- outreach.tone: Lead with the customer's metric, not ours.");
  });
});

describe("auto-demotion", () => {
  it("selects deltas whose runs correlate with critic failures and demotion excludes them from folding", async () => {
    const log = new InMemoryCompanyPlaybookLog();
    const bad = delta({ topic: "bad.rule", text: "Always promise same-day delivery." });
    const good = delta({ topic: "good.rule", text: "Cite sources." });
    await log.append(bad);
    await log.append(good);

    const demote = selectDeltasToDemote([
      { entryId: bad.id, runsWithDelta: 4, criticFailures: 3 },
      { entryId: good.id, runsWithDelta: 4, criticFailures: 0 },
      { entryId: "too_few_runs", runsWithDelta: 2, criticFailures: 2 },
    ]);
    expect(demote).toEqual([bad.id]);

    for (const id of demote) await log.setStatus("co_1", id, "deprecated");
    const folded = foldPlaybook(await log.list("co_1"));
    expect(folded.bullets.map((bullet) => bullet.topic)).toEqual(["good.rule"]);
  });
});

describe("playbookDeltasFromReflection", () => {
  it("maps reflection lessons to deltas and drops empty ones", () => {
    const deltas = playbookDeltasFromReflection({
      companyId: "co_1",
      sourceRunId: "orcrun_1",
      lessons: [
        { topic: "outreach.tone", text: "Shorter subject lines." },
        { topic: "  ", text: "no topic — dropped" },
        { topic: "ads.budget", text: "", kind: "deprecate" },
      ],
    });

    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ kind: "add", topic: "outreach.tone", sourceRunId: "orcrun_1" });
    expect(deltas[1]).toMatchObject({ kind: "deprecate", topic: "ads.budget" });
  });
});
