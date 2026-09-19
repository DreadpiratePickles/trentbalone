/**
 * [D0] gate 6 — judge calibration as rates, never raw agreement.
 *
 * `status.ts` reported one number: how often the gate's verdict matched the human's decision. A
 * judge that says yes to everything scores 0.9 on a company that promotes nine drafts in ten, and
 * a loop that weights the judge by that number rewards exactly the wrong behaviour (design review
 * section 6, item 5; CS329A G9). The two rates that cannot be gamed together are:
 *
 *   TPR = promoted-by-human and the gate agreed / every human promotion that was gated
 *   TNR = rejected-by-human and the gate agreed / every human rejection that was gated
 *
 * Below either floor the judge is ADVISORY: its verdicts are reported and stored, and the gate
 * refuses to let one make a fixture pass, so a rubric-only suite cannot promote anything while
 * the judge is miscalibrated. A side with no decisions yet has a null rate and is not a breach:
 * an unmeasured judge is not a bad one, and the counts say which it is.
 */

import type { SkillLedgerRow } from "../store/StorePort.js";

export const DEFAULT_JUDGE_MIN_TPR = 0.8;
export const DEFAULT_JUDGE_MIN_TNR = 0.8;

export interface JudgeCalibration {
  /** Human promoted, gate agreed. */
  truePositives: number;
  /** Human promoted, gate would have blocked. */
  falseNegatives: number;
  /** Human rejected, gate agreed. */
  trueNegatives: number;
  /** Human rejected, gate would have promoted: the failure a raw agreement rate hides. */
  falsePositives: number;
  /** Two decimals; null while that side has no gated human decision. */
  tpr: number | null;
  tnr: number | null;
  agreed: number;
  disagreed: number;
  /** Raw agreement, kept because it is what older ledgers reported — never shown on its own. */
  rate: number | null;
}

export interface JudgeFloors {
  readonly minTpr?: number;
  readonly minTnr?: number;
}

function ratio(hit: number, total: number): number | null {
  return total === 0 ? null : Math.round((hit / total) * 100) / 100;
}

/** A human promote or fix is a positive decision; a human reject is a negative one. */
function decisionOf(row: SkillLedgerRow): "positive" | "negative" | undefined {
  if (row.judgeAgreement !== true && row.judgeAgreement !== false) return undefined;
  if (row.action === "promote" || row.action === "fix") return "positive";
  if (row.action === "reject") return "negative";
  return undefined;
}

export function judgeCalibration(ledger: readonly SkillLedgerRow[]): JudgeCalibration {
  let truePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;
  for (const row of ledger) {
    const decision = decisionOf(row);
    if (decision === "positive") row.judgeAgreement === true ? (truePositives += 1) : (falseNegatives += 1);
    else if (decision === "negative") row.judgeAgreement === true ? (trueNegatives += 1) : (falsePositives += 1);
  }
  const agreed = truePositives + trueNegatives;
  const disagreed = falseNegatives + falsePositives;
  return {
    truePositives,
    falseNegatives,
    trueNegatives,
    falsePositives,
    tpr: ratio(truePositives, truePositives + falseNegatives),
    tnr: ratio(trueNegatives, trueNegatives + falsePositives),
    agreed,
    disagreed,
    rate: ratio(agreed, agreed + disagreed),
  };
}

/** True when a measured rate is below its floor. An unmeasured rate (null) is not a breach. */
export function isJudgeAdvisory(calibration: JudgeCalibration, floors: JudgeFloors = {}): boolean {
  const minTpr = floors.minTpr ?? DEFAULT_JUDGE_MIN_TPR;
  const minTnr = floors.minTnr ?? DEFAULT_JUDGE_MIN_TNR;
  return (calibration.tpr !== null && calibration.tpr < minTpr) || (calibration.tnr !== null && calibration.tnr < minTnr);
}
