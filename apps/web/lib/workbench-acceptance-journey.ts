/**
 * workbench-acceptance-journey.ts — turn an objective into a multi-step browser
 * acceptance journey for the interaction verifier.
 *
 * The interaction verifier (workbench-interaction-verify.ts) can already drive a
 * real browser through click/type/assert steps, but with no steps it only does a
 * one-shot "click the first button" smoke test — which passes Potemkin UIs where a
 * feature renders but does nothing. This derives a richer, objective-specific
 * journey (e.g. for a todo app: type an item, add it, assert it appears) so the
 * verdict reflects whether the feature actually works.
 *
 * Conservative by design: only emits input-driven steps when the objective clearly
 * implies an add-to-list interaction; otherwise falls back to the smoke step that
 * already runs today (so it never introduces a new false-failure mode).
 */

import type { AcceptanceStep } from "@/lib/workbench-interaction-verify";

const SMOKE_STEP: AcceptanceStep = {
  action: "click first visible button",
  expect: "page responds with DOM change or network activity",
};

// A distinctive token we type and then assert appears — unlikely to pre-exist in
// the UI, so a passing assertion means the input→render path actually works.
const PROBE = "Trent QA 4271";

const ADD_TO_LIST = /\b(todo|to-do|task list|tasks?|notes?|checklist|grocery|shopping list|reminders?|kanban|list app|add (?:an? )?(?:item|task|note|todo))\b/i;
const COUNTER = /\b(counter|increment|tally|click counter|stopwatch|timer)\b/i;

/** Build an acceptance journey from the objective. */
export function deriveAcceptanceJourney(objective: string): AcceptanceStep[] {
  const text = (objective ?? "").toLowerCase();

  if (ADD_TO_LIST.test(text)) {
    return [
      { action: `type '${PROBE}' in input`, expect: "page responds with DOM change or network activity" },
      { action: "click first visible button", expect: `visible text includes '${PROBE}'` },
    ];
  }

  if (COUNTER.test(text)) {
    return [
      { action: "click first visible button", expect: "page responds with DOM change or network activity" },
    ];
  }

  return [SMOKE_STEP];
}
