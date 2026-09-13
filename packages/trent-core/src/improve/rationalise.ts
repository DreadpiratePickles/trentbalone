/**
 * Rationalisation on goldens (task I.14; CS329A L6 @18:48, STaR: give the solved problem its
 * answer, ask for the rationale, keep "step + why" as the training signal).
 *
 * For a distilled golden (`clean-trace.ts`) the model is asked ONCE, metered under the
 * `rationalise` phase, for a short reason per step; the answer is stored next to the golden so
 * the Foundry and the GEPA reflection read why each step was taken, not only that it was. The
 * ask is content-addressed: a golden whose `rationaleOf` equals the hash of its current step
 * list is not asked again, so a repeat promotion costs nothing. An unparseable reply stores no
 * rationale (a golden with no "why" is still a golden) but the call is still counted, because it
 * was paid for. The prompt carries step titles, tools and outputs; it is sent, never logged.
 *
 * Exemplars live in an `ExemplarStore`: in memory for tests, or one JSON file per golden under a
 * directory the CLI owns (next to the failure goldens of `golden-capture.ts`).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ModelGateway } from "../model-gateway/types.js";
import { goldenStepsHash, type CleanGolden } from "./clean-trace.js";
import type { SweepMeter } from "./meter.js";

/** Sends the rationale prompt to a model and returns its reply with integer cents. Injected; never a default. */
export type RationaleFn = (prompt: string) => Promise<{ text: string; costCents: number }>;

export interface ExemplarStore {
  get(id: string): Promise<CleanGolden | undefined>;
  put(golden: CleanGolden): Promise<void>;
  list(): Promise<CleanGolden[]>;
}

export function createMemoryExemplarStore(): ExemplarStore {
  const rows = new Map<string, CleanGolden>();
  return {
    async get(id) {
      const row = rows.get(id);
      return row ? structuredClone(row) : undefined;
    },
    async put(golden) {
      rows.set(golden.id, structuredClone(golden));
    },
    async list() {
      return [...rows.values()].map((g) => structuredClone(g)).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
    },
  };
}

function isGolden(value: unknown): value is CleanGolden {
  const g = value as Partial<CleanGolden> | null;
  return typeof g === "object" && g !== null && typeof g.id === "string" && typeof g.distilledFrom === "string" && Array.isArray(g.steps);
}

/** `<dir>/<golden id>.json`, one file per exemplar; malformed files are skipped, never guessed. */
export function createFileExemplarStore(dir: string): ExemplarStore {
  const file = (id: string) => path.join(dir, `${id}.json`);
  const read = (name: string): CleanGolden | undefined => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      return isGolden(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async get(id) {
      return read(`${id}.json`);
    },
    async put(golden) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file(golden.id), `${JSON.stringify(golden, null, 2)}\n`, "utf8");
    },
    async list() {
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.startsWith("golden_") && n.endsWith(".json"));
      } catch {
        return [];
      }
      return names
        .map(read)
        .filter((g): g is CleanGolden => g !== undefined)
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
    },
  };
}

const RATIONALE_SYSTEM = [
  "You are given the steps an agent took to complete a task successfully.",
  "For each step, state in one short sentence why that step was the right one to take at that point.",
  'Reply with a single JSON object and nothing else: {"steps":[{"index":1,"why":"..."}, ...]} with one entry per step, in order.',
].join("\n");

export function buildRationalePrompt(golden: CleanGolden): string {
  const steps = golden.steps.map((s, i) => {
    const tool = s.tool === undefined ? "" : ` tool=${s.tool}${s.args === undefined ? "" : ` args=${JSON.stringify(s.args)}`}`;
    const output = s.output === undefined ? "" : ` output=${JSON.stringify(s.output.slice(0, 200))}`;
    return `${i + 1}. ${s.title}${tool}${output}`;
  });
  return [RATIONALE_SYSTEM, "", ...(golden.objective === undefined ? [] : [`TASK: ${golden.objective}`, ""]), "STEPS:", ...steps].join("\n");
}

/** One "why" per step, in order; undefined when the reply is not the expected shape. */
export function parseRationaleReply(text: string, stepCount: number): string[] | undefined {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as { steps?: unknown };
    if (!Array.isArray(parsed.steps)) return undefined;
    const byIndex = new Map<number, string>();
    for (const entry of parsed.steps as Array<{ index?: unknown; why?: unknown }>) {
      if (typeof entry?.index === "number" && typeof entry.why === "string") byIndex.set(entry.index, entry.why.trim());
    }
    const out: string[] = [];
    for (let i = 1; i <= stepCount; i += 1) out.push(byIndex.get(i) ?? "");
    return out.some((w) => w !== "") ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Binds the rationale ask to the real gateway at temperature 0; integer cents from its own usage. */
export function createGatewayRationale(gateway: ModelGateway, maxTokens = 512): RationaleFn {
  return async (prompt) => {
    const completion = await gateway.complete({ messages: [{ role: "user", content: prompt }], role: "executor", maxTokens, temperature: 0 });
    return { text: completion.text, costCents: Math.max(0, Math.trunc(completion.costCents)) };
  };
}

export interface RationaliseOptions {
  readonly ask: RationaleFn;
  readonly meter: SweepMeter;
  readonly store: ExemplarStore;
}

export interface RationaliseResult {
  golden: CleanGolden;
  /** True when a model call was made and produced a rationale this time. */
  rationalised: boolean;
}

/** Stores the golden; asks for a rationale only when its step list has none yet. */
export async function rationaliseGolden(golden: CleanGolden, options: RationaliseOptions): Promise<RationaliseResult> {
  const address = goldenStepsHash(golden.steps);
  const stored = await options.store.get(golden.id);
  const known = golden.rationaleOf === address && golden.rationale !== undefined ? golden : stored?.rationaleOf === address && stored.rationale !== undefined ? stored : undefined;
  if (known) {
    const merged: CleanGolden = { ...golden, rationale: known.rationale as string[], rationaleOf: address };
    await options.store.put(merged);
    return { golden: merged, rationalised: false };
  }
  const reply = await options.meter.rationale(options.ask)(buildRationalePrompt(golden));
  const rationale = parseRationaleReply(reply.text, golden.steps.length);
  const { rationale: _stale, rationaleOf: _staleOf, ...bare } = golden;
  const next: CleanGolden = rationale === undefined ? bare : { ...bare, rationale, rationaleOf: address };
  await options.store.put(next);
  return { golden: next, rationalised: rationale !== undefined };
}
