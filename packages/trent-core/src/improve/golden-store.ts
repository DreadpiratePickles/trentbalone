/**
 * [D1] the goldens directory as a reviewable store.
 *
 * A failure golden is a JSON file the capture wrote under `<profileDir>/goldens`
 * (`golden-capture.ts` wraps `apps/web/lib/orchestration-golden-capture.ts`, which owns the
 * format and the redaction). This module is the read and review side the command line needs:
 * list what was captured, and record a human's decision on one.
 *
 * The file's vocabulary is the application's — a promoted golden is `blocking`, because that is
 * what the app's own suite runner filters on — and the loop's vocabulary is `quarantined`,
 * `promoted`, `rejected`. `reviewOf` is the one place the two meet, so nothing else has to know.
 *
 * Reads go through `node:fs` rather than the app's lister: the profile's goldens are plain files,
 * and a CLI listing must not drag the app's audit log and its database client in behind it.
 *
 * Writing here is a HUMAN command (`trent improve goldens promote|reject`). The loop itself may
 * never write this directory — `frozen-surface.ts` freezes `<profileDir>/goldens` as class
 * `golden`, and that refusal is what keeps the loop from promoting its own exam.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { EXIT, TrentError } from "../errors/index.js";

/** What a human decided about a golden. The loop's vocabulary. */
export type GoldenReview = "quarantined" | "promoted" | "rejected";

/** The status the application writes for a golden a human promoted. */
export const PROMOTED_ON_DISK = "blocking";

/**
 * One captured golden, as the app's `CapturedOrchestrationGolden` writes it, plus the fields a
 * reviewer may add by hand. Everything optional is absent on a capture the app wrote itself.
 */
export interface StoredGolden {
  readonly id: string;
  readonly runId: string;
  readonly companyId?: string;
  /** Sanitised by the capture; this is what re-runs as the fixture prompt. */
  readonly objective: string;
  readonly reason: string;
  readonly status: string;
  readonly trajectoryFailureTags?: readonly string[];
  readonly capturedAt?: string;
  readonly promotedAt?: string;
  readonly rejectedAt?: string;
  /** Seats this golden belongs to, when a reviewer named them; otherwise the run's traces decide. */
  readonly seats?: readonly string[];
  /** Natural-language assertions a reviewer added; each becomes one rubric grader. */
  readonly assertions?: readonly string[];
  readonly contains?: readonly string[];
  readonly required_tools?: readonly string[];
  readonly forbidden_tools?: readonly string[];
}

/** Where a profile keeps its captured goldens. The capture writes here; the loop may not. */
export function goldensDir(profileDir: string): string {
  return path.join(profileDir, "goldens");
}

export function reviewOf(golden: StoredGolden): GoldenReview {
  if (golden.status === PROMOTED_ON_DISK || golden.status === "promoted") return "promoted";
  if (golden.status === "rejected") return "rejected";
  return "quarantined";
}

export function promotedGoldens(goldens: readonly StoredGolden[]): StoredGolden[] {
  return goldens.filter((golden) => reviewOf(golden) === "promoted");
}

export function quarantinedGoldens(goldens: readonly StoredGolden[]): StoredGolden[] {
  return goldens.filter((golden) => reviewOf(golden) === "quarantined");
}

function parseGolden(raw: string): StoredGolden | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredGolden>;
    if (typeof parsed.id !== "string" || typeof parsed.objective !== "string" || typeof parsed.runId !== "string") return undefined;
    return {
      ...parsed,
      id: parsed.id,
      runId: parsed.runId,
      objective: parsed.objective,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      status: typeof parsed.status === "string" ? parsed.status : "quarantined",
    };
  } catch {
    return undefined;
  }
}

/** Every golden in the directory, oldest file name first. A missing directory is no goldens. */
export async function listGoldens(dir: string): Promise<StoredGolden[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const goldens: StoredGolden[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const golden = parseGolden(await fs.readFile(path.join(dir, entry), "utf8").catch(() => ""));
    if (golden) goldens.push(golden);
  }
  return goldens;
}

/** The file a golden lives in, found by id rather than guessed from the run id. */
async function fileFor(dir: string, goldenId: string): Promise<{ file: string; golden: StoredGolden }> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const file = path.join(dir, entry);
    const golden = parseGolden(await fs.readFile(file, "utf8").catch(() => ""));
    if (golden?.id === goldenId) return { file, golden };
  }
  throw new TrentError({ code: EXIT.USAGE, operation: "improve.goldens", message: `no captured golden ${goldenId} under ${dir}`, target: goldenId });
}

export async function getGolden(dir: string, goldenId: string): Promise<StoredGolden> {
  return (await fileFor(dir, goldenId)).golden;
}

/**
 * Record a human's decision. The review timestamp is written beside the status so
 * `trent improve goldens list` can show when a suite last changed shape.
 */
export async function setGoldenStatus(dir: string, goldenId: string, review: GoldenReview, now: string): Promise<StoredGolden> {
  const { file, golden } = await fileFor(dir, goldenId);
  const updated: StoredGolden = {
    ...golden,
    status: review === "promoted" ? PROMOTED_ON_DISK : review,
    ...(review === "promoted" ? { promotedAt: now } : {}),
    ...(review === "rejected" ? { rejectedAt: now } : {}),
  };
  await fs.writeFile(file, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}
