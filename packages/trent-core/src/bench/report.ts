/**
 * [C16] The bench report: per harness, pass@1, pass^k (k = runs per task; the council's pass^3), the median
 * time to first token, the wall time, and the cost per successful task; the Hermes version and the model;
 * and the three targets the council pre-registered, judged from the same numbers.
 *
 * Integer arithmetic throughout: rates are kept as `passed / of` and compared by cross-multiplication, times
 * are whole milliseconds (an even median is the floor of its two middles' mean), money is integer cents and
 * integer micro-cents (1 cent = 1,000,000), and the cost per success is every attempt's list price, failures
 * included, divided by the successful attempts and rounded UP once. Percentages exist only in the rendered
 * text, to one decimal, floored.
 */
import { MICRO_PER_CENT } from "./cost.js";
import type { HermesVersion } from "./hermes-runner.js";
import { TASK_CLASSES, type HarnessId, type TaskClass, type TaskRun } from "./types.js";

export interface Rate {
  readonly passed: number;
  readonly of: number;
}

export interface HarnessSummary {
  readonly harness: HarnessId;
  readonly tasks: number;
  readonly attempts: number;
  readonly successes: number;
  readonly passAt1: Rate;
  readonly passHatK: Rate & { readonly k: number };
  readonly ttftMedianMs: number | null;
  readonly wall: { readonly totalMs: number; readonly medianMs: number | null };
  readonly cost: { readonly microCents: number; readonly ledgerCents: number; readonly microCentsPerSuccess: number | null; readonly unpriced: boolean };
  readonly byClass: Partial<Record<TaskClass, Rate>>;
  readonly statuses: Partial<Record<TaskRun["status"], number>>;
}

export interface TargetVerdict {
  readonly id: "solo-pass-at-1-vs-hermes" | "flash-lite-cost-per-success" | "fleet-wins-a-task-class";
  /** Null when the target does not apply to this run (a harness absent, another model). */
  readonly holds: boolean | null;
  readonly detail: string;
}

export interface ReportMeta {
  readonly suite: string;
  readonly fingerprint: string;
  readonly model: string;
  readonly runsPerTask: number;
  readonly harnesses: readonly HarnessId[];
  readonly hermes?: HermesVersion;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface BuiltReport extends Omit<ReportMeta, "harnesses"> {
  readonly harnesses: readonly HarnessSummary[];
  readonly targets: readonly TargetVerdict[];
  readonly runs: readonly TaskRun[];
}

/** The model the cost target is registered for. */
export const COST_TARGET_MODEL = "gemini-3.5-flash-lite";
/** At most half a cent per successful task, in micro-cents. */
export const COST_TARGET_MICRO_CENTS = MICRO_PER_CENT / 2;

export function medianMs(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.floor((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** a/b > c/d, for whole counts, without a float; an empty rate is 0. */
function beats(a: Rate, b: Rate): boolean {
  return a.passed * Math.max(1, b.of) > b.passed * Math.max(1, a.of);
}

function summarise(harness: HarnessId, runs: readonly TaskRun[], k: number): HarnessSummary {
  const taskIds = [...new Set(runs.map((run) => run.taskId))];
  const first = runs.filter((run) => run.attempt === 1);
  const allK = taskIds.filter((id) => {
    const attempts = runs.filter((run) => run.taskId === id);
    return Array.from({ length: k }, (_, index) => index + 1).every((n) => attempts.some((run) => run.attempt === n && run.passed));
  });
  const byClass: Partial<Record<TaskClass, Rate>> = {};
  for (const taskClass of TASK_CLASSES) {
    const inClass = first.filter((run) => run.taskClass === taskClass);
    if (inClass.length > 0) byClass[taskClass] = { passed: inClass.filter((run) => run.passed).length, of: inClass.length };
  }
  const statuses: Partial<Record<TaskRun["status"], number>> = {};
  for (const run of runs) statuses[run.status] = (statuses[run.status] ?? 0) + 1;
  const successes = runs.filter((run) => run.passed).length;
  const microCents = runs.reduce((sum, run) => sum + run.microCents, 0);
  return {
    harness,
    tasks: taskIds.length,
    attempts: runs.length,
    successes,
    passAt1: { passed: first.filter((run) => run.passed).length, of: taskIds.length },
    passHatK: { k, passed: allK.length, of: taskIds.length },
    ttftMedianMs: medianMs(runs.flatMap((run) => (run.ttftMs === null ? [] : [run.ttftMs]))),
    wall: { totalMs: runs.reduce((sum, run) => sum + run.wallMs, 0), medianMs: medianMs(runs.map((run) => run.wallMs)) },
    cost: {
      microCents,
      ledgerCents: runs.reduce((sum, run) => sum + run.ledgerCents, 0),
      microCentsPerSuccess: successes === 0 ? null : Math.ceil(microCents / successes),
      unpriced: runs.some((run) => run.unpriced),
    },
    byClass,
    statuses,
  };
}

const fraction = (rate: Rate): string => `${String(rate.passed)}/${String(rate.of)}`;

/** Micro-cents as cents with six decimals, from integers only. */
export function centsText(micro: number): string {
  return `${String(Math.floor(micro / MICRO_PER_CENT))}.${String(micro % MICRO_PER_CENT).padStart(6, "0")}`;
}

function judge(summaries: readonly HarnessSummary[], model: string): TargetVerdict[] {
  const of = (id: HarnessId) => summaries.find((summary) => summary.harness === id);
  const solo = of("trent-solo");
  const hermes = of("hermes");
  const fleet = of("trent-fleet");
  const verdicts: TargetVerdict[] = [];
  verdicts.push(
    solo === undefined || hermes === undefined
      ? { id: "solo-pass-at-1-vs-hermes", holds: null, detail: "needs both trent-solo and hermes in the same run" }
      : { id: "solo-pass-at-1-vs-hermes", holds: !beats(hermes.passAt1, solo.passAt1), detail: `trent-solo ${fraction(solo.passAt1)} against hermes ${fraction(hermes.passAt1)} on ${model}` },
  );
  if (model !== COST_TARGET_MODEL) verdicts.push({ id: "flash-lite-cost-per-success", holds: null, detail: `registered for ${COST_TARGET_MODEL}; this run is on ${model}` });
  else if (solo === undefined) verdicts.push({ id: "flash-lite-cost-per-success", holds: null, detail: "needs trent-solo in the run" });
  else if (solo.cost.microCentsPerSuccess === null) verdicts.push({ id: "flash-lite-cost-per-success", holds: false, detail: "trent-solo had no successful task" });
  else verdicts.push({ id: "flash-lite-cost-per-success", holds: solo.cost.microCentsPerSuccess <= COST_TARGET_MICRO_CENTS, detail: `trent-solo ${centsText(solo.cost.microCentsPerSuccess)} cents per successful task (target at most 0.5)` });
  const others = summaries.filter((summary) => summary.harness !== "trent-fleet");
  if (fleet === undefined || others.length === 0) {
    verdicts.push({ id: "fleet-wins-a-task-class", holds: null, detail: "needs trent-fleet and at least one other harness" });
  } else {
    const won = TASK_CLASSES.filter((taskClass) => {
      const mine = fleet.byClass[taskClass];
      return mine !== undefined && others.every((other) => beats(mine, other.byClass[taskClass] ?? { passed: 0, of: 0 }));
    });
    verdicts.push({ id: "fleet-wins-a-task-class", holds: won.length > 0, detail: won.length === 0 ? "trent-fleet wins no task class" : `trent-fleet wins ${won.join(", ")}` });
  }
  return verdicts;
}

export function buildReport(runs: readonly TaskRun[], meta: ReportMeta): BuiltReport {
  const order = [...meta.harnesses, ...runs.map((run) => run.harness)].filter((id, index, all) => all.indexOf(id) === index);
  const summaries = order.flatMap((harness) => {
    const mine = runs.filter((run) => run.harness === harness);
    return mine.length === 0 ? [] : [summarise(harness, mine, meta.runsPerTask)];
  });
  return { ...meta, harnesses: summaries, targets: judge(summaries, meta.model), runs: [...runs] };
}

const percent = (rate: Rate): string => {
  const tenths = rate.of === 0 ? 0 : Math.floor((rate.passed * 1000) / rate.of);
  return `${String(Math.floor(tenths / 10))}.${String(tenths % 10)}%`;
};
const ms = (value: number | null): string => (value === null ? "-" : `${String(value)} ms`);
const pad = (text: string, width: number): string => text.padEnd(width);

export function renderReport(report: BuiltReport): string[] {
  const lines = [
    `trent bench: ${report.suite} (fingerprint ${report.fingerprint}) on ${report.model}, ${String(report.runsPerTask)} runs per task`,
    `Hermes: ${report.hermes === undefined ? "not run" : `${report.hermes.version} (${report.hermes.source})`}`,
    "",
    [pad("harness", 13), pad("pass@1", 14), pad(`pass^${String(report.runsPerTask)}`, 14), pad("ttft p50", 11), pad("wall p50", 11), pad("wall total", 12), pad("cents/success", 15), "ledger cents"].join(""),
  ];
  for (const h of report.harnesses) {
    const perSuccess = h.cost.microCentsPerSuccess === null ? "-" : centsText(h.cost.microCentsPerSuccess);
    lines.push([
      pad(h.harness, 13), pad(`${fraction(h.passAt1)} ${percent(h.passAt1)}`, 14), pad(`${fraction(h.passHatK)} ${percent(h.passHatK)}`, 14),
      pad(ms(h.ttftMedianMs), 11), pad(ms(h.wall.medianMs), 11), pad(ms(h.wall.totalMs), 12), pad(`${perSuccess}${h.cost.unpriced ? "*" : ""}`, 15), String(h.cost.ledgerCents),
    ].join(""));
  }
  if (report.harnesses.some((h) => h.cost.unpriced)) lines.push("* some tokens are not in the price table; those cents are the gateway's stand-in");
  lines.push("", `pass@1 by class: ${TASK_CLASSES.join(", ")}`);
  for (const h of report.harnesses) lines.push(`  ${pad(h.harness, 13)}${TASK_CLASSES.map((c) => (h.byClass[c] === undefined ? "-" : fraction(h.byClass[c]!))).join("  ")}`);
  lines.push("", "pre-registered targets (council C16):");
  for (const target of report.targets) lines.push(`  ${pad(target.holds === null ? "n/a" : target.holds ? "holds" : "fails", 7)}${target.id}: ${target.detail}`);
  return lines;
}
