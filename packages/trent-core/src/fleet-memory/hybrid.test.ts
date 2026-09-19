/**
 * Hybrid recall (C3): the blend of lexical TF-IDF and embedding cosine, and the two orders it
 * must produce — the paraphrase first when an embedder is present, the keyword collision first
 * when there is none. Offline: the embedder here is a fake with hand-made topic axes.
 */
import { describe, expect, it } from "vitest";
import {
  HYBRID_LEXICAL_WEIGHT,
  HYBRID_VECTOR_FLOOR,
  HYBRID_VECTOR_WEIGHT,
  blendScores,
  vectorCredit,
} from "./hybrid.js";
import { DEFAULT_FLEET_MEMORY_CONFIG } from "./config.js";
import { EMBEDDER_ROUTES } from "./embedder.js";
import { scoreAgainst, type CalibratedEmbedFn, type EmbedFn } from "./lexical.js";
import { recallForObjective } from "./recall.js";
import { InMemoryFleetSource, type FleetRun } from "./source.js";

const COMPANY = "co_hybrid";

const OBJECTIVE = "reduce monthly churn on the annual subscription tier";
/** The same subject in different words. After stemming it shares NO token with the objective. */
const PARAPHRASE =
  "retention review: yearly customers stopped cancelling once onboarding covered the second seat";
/** Four literal tokens in common (monthly, subscription, annual, tier) and a different subject. */
const COLLISION =
  "the monthly office subscription and the annual parking tier were renewed by facilities";

/**
 * A fake embedder with two topic axes plus a shared "prose" axis, so no pair is exactly
 * orthogonal and no pair is exactly identical — the shape a real model returns.
 */
const TOPIC_AXES: ReadonlyArray<readonly string[]> = [
  ["churn", "retention", "cancelling", "renewal"],
  ["office", "parking", "facilities", "desk"],
];
const PROSE_WEIGHT = 0.3;

const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((text) => {
    const lower = text.toLowerCase();
    const axes = TOPIC_AXES.map((words) => (words.some((w) => lower.includes(w)) ? 1 : 0));
    return [...axes, PROSE_WEIGHT];
  });

function run(id: string, steps: Array<{ role: string; title: string; output: string }>): FleetRun {
  return {
    id,
    companyId: COMPANY,
    objective: id,
    status: "completed",
    summary: null,
    completedAt: "2026-09-18T10:00:00.000Z",
    steps: steps.map((s, i) => ({
      id: `${id}-s${i + 1}`,
      runId: id,
      agentRole: s.role,
      title: s.title,
      status: "completed",
      output: s.output,
    })),
  };
}

describe("hybrid blend", () => {
  it("weights sum to 1 so a blended score stays on the lexical scale", () => {
    expect(HYBRID_LEXICAL_WEIGHT + HYBRID_VECTOR_WEIGHT).toBeCloseTo(1, 10);
    expect(HYBRID_VECTOR_WEIGHT).toBeGreaterThan(HYBRID_LEXICAL_WEIGHT);
  });

  it("gives no vector credit at or below the floor and full credit at cosine 1", () => {
    expect(vectorCredit(HYBRID_VECTOR_FLOOR)).toBe(0);
    expect(vectorCredit(HYBRID_VECTOR_FLOOR - 0.2)).toBe(0);
    expect(vectorCredit(-1)).toBe(0);
    expect(vectorCredit(1)).toBeCloseTo(1, 10);
    expect(vectorCredit(Number.NaN)).toBe(0);
  });

  it("takes the floor from the model when one is given: Gemini's 0.529 baseline earns nothing", () => {
    // The figures `embedder.live.test.ts` measured on gemini-embedding-001.
    const gemini = EMBEDDER_ROUTES.gemini.vectorFloor;
    expect(vectorCredit(0.5292, gemini)).toBe(0);
    expect(vectorCredit(0.7538, gemini)).toBeGreaterThan(0);
    // The same pair under the default floor would let the unrelated sentence through.
    expect(vectorCredit(0.5292)).toBeGreaterThan(0);
  });

  it("honours a floor declared on the EmbedFn itself, since the hook's seam is a bare EmbedFn", async () => {
    const withFloor = (floor: number): CalibratedEmbedFn =>
      Object.assign(async (texts: readonly string[]) => fakeEmbed(texts), { vectorFloor: floor });

    // The paraphrase embeds identically to the objective (cosine 1), so it clears any floor.
    const [kept] = await scoreAgainst(OBJECTIVE, [PARAPHRASE], withFloor(0.9));
    expect(kept).toBeGreaterThan(HYBRID_LEXICAL_WEIGHT);

    // The collision's cosine is ~0.08, which clears the default floor nowhere and a 0.9 floor
    // certainly not: with the floor honoured its score is its lexical score alone, scaled.
    const [lenient] = await scoreAgainst(OBJECTIVE, [COLLISION], withFloor(0.02));
    const [strict] = await scoreAgainst(OBJECTIVE, [COLLISION], withFloor(0.9));
    expect(lenient!).toBeGreaterThan(strict!);
    expect(strict!).toBeLessThan(HYBRID_LEXICAL_WEIGHT);
  });

  it("blends element-wise and keeps the arrays aligned", () => {
    const blended = blendScores([1, 0], [0, 1]);
    expect(blended[0]).toBeCloseTo(HYBRID_LEXICAL_WEIGHT, 10);
    expect(blended[1]).toBeCloseTo(HYBRID_VECTOR_WEIGHT, 10);
  });
});

describe("scoreAgainst with and without an embedder", () => {
  const candidates = [PARAPHRASE, COLLISION];

  it("without an embedder the keyword collision wins, exactly as before", async () => {
    const [paraphrase, collision] = await scoreAgainst(OBJECTIVE, candidates);
    expect(collision).toBeGreaterThan(0);
    expect(paraphrase).toBe(0);
    expect(collision!).toBeGreaterThan(paraphrase!);
  });

  it("with an embedder the paraphrase outranks the keyword collision", async () => {
    const [paraphrase, collision] = await scoreAgainst(OBJECTIVE, candidates, fakeEmbed);
    expect(paraphrase!).toBeGreaterThan(collision!);
  });

  it("normalises provider vectors that are not unit length", async () => {
    const scaled: EmbedFn = async (texts) =>
      (await fakeEmbed(texts)).map((v) => v.map((x) => x * 17));
    const unscaled = await scoreAgainst(OBJECTIVE, candidates, fakeEmbed);
    const rescaled = await scoreAgainst(OBJECTIVE, candidates, scaled);
    expect(rescaled[0]).toBeCloseTo(unscaled[0]!, 10);
    expect(rescaled[1]).toBeCloseTo(unscaled[1]!, 10);
  });
});

describe("recall ranking end to end", () => {
  function seeded(): InMemoryFleetSource {
    const source = new InMemoryFleetSource();
    source.addRun(run("run_paraphrase", [{ role: "growth", title: "Quarterly review", output: PARAPHRASE }]));
    source.addRun(run("run_collision", [{ role: "ops", title: "Vendor ledger", output: COLLISION }]));
    return source;
  }

  // Both candidates are kept so the two runs differ in ONE input: the embedder.
  const rankAll = { ...DEFAULT_FLEET_MEMORY_CONFIG, recallMinScore: 0 };

  it("ranks the paraphrase above the collision when an embedder is wired", async () => {
    const result = await recallForObjective(seeded(), {
      companyId: COMPANY,
      seat: "growth",
      objective: OBJECTIVE,
      config: rankAll,
      embed: fakeEmbed,
    });
    expect(result.items.map((i) => i.agentId)).toEqual(["growth", "ops"]);
    expect(result.items[0]!.score).toBeGreaterThan(result.items[1]!.score);
  });

  it("keeps the lexical order when no embedder is wired", async () => {
    const result = await recallForObjective(seeded(), {
      companyId: COMPANY,
      seat: "growth",
      objective: OBJECTIVE,
      config: rankAll,
    });
    expect(result.items.map((i) => i.agentId)).toEqual(["ops", "growth"]);
  });
});
