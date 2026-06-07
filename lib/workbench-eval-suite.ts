import { median, passRate, roundMetric } from "@/lib/eval-scorecard";

export type WorkbenchGoldenObjective = {
  id: string;
  objective: string;
  difficulty: "easy" | "medium" | "hard";
};

export type WorkbenchEvalInput = {
  objectiveId: string;
  buildClean: boolean;
  interactionsPass: boolean;
  criticPass: boolean;
  screenshotNonBlank: boolean;
  attempts: number;
  costCents: number;
  wallClockMs: number;
};

export type WorkbenchEvalResult = WorkbenchEvalInput & {
  passed: boolean;
  failureTags: string[];
};

export type WorkbenchEvalScorecard = {
  suite: "workbench";
  objectiveCount: number;
  passRate: number;
  medianAttempts: number;
  medianCostCents: number;
  medianWallClockMs: number;
  objectives: WorkbenchEvalResult[];
};

const GOLDEN_OBJECTIVES: WorkbenchGoldenObjective[] = [
  { id: "wb_countdown", objective: "Build a countdown timer with start, pause, and reset controls.", difficulty: "easy" },
  { id: "wb_notes", objective: "Build a notes app with add, edit, and delete notes.", difficulty: "easy" },
  { id: "wb_todo", objective: "Build a todo list where items can be checked off and filtered.", difficulty: "easy" },
  { id: "wb_landing", objective: "Build a product landing page with hero, features, and CTA sections.", difficulty: "medium" },
  { id: "wb_pricing", objective: "Build a pricing table with three tiers and a monthly/yearly toggle.", difficulty: "medium" },
  { id: "wb_dashboard", objective: "Build a metrics dashboard with cards and a simple chart.", difficulty: "medium" },
  { id: "wb_contact", objective: "Build a contact form with validation and success feedback.", difficulty: "medium" },
  { id: "wb_auth_ui", objective: "Build a login and signup flow UI with field validation.", difficulty: "medium" },
  { id: "wb_kanban", objective: "Build a kanban board with drag-ready columns and cards.", difficulty: "hard" },
  { id: "wb_calendar", objective: "Build a week-view calendar with event creation.", difficulty: "hard" },
  { id: "wb_ecommerce", objective: "Build a product catalog with cart add/remove interactions.", difficulty: "hard" },
  { id: "wb_blog", objective: "Build a blog index with post cards and a detail view.", difficulty: "medium" },
  { id: "wb_faq", objective: "Build an FAQ accordion with expand/collapse interactions.", difficulty: "easy" },
  { id: "wb_onboarding", objective: "Build a multi-step onboarding wizard with progress indicator.", difficulty: "hard" },
  { id: "wb_settings", objective: "Build a settings page with profile and notification toggles.", difficulty: "medium" },
];

export function buildWorkbenchGoldenObjectives(): WorkbenchGoldenObjective[] {
  return GOLDEN_OBJECTIVES.map((item) => ({ ...item }));
}

export function scoreWorkbenchObjective(input: WorkbenchEvalInput): WorkbenchEvalResult {
  const failureTags: string[] = [];
  if (!input.buildClean) failureTags.push("build_failed");
  if (!input.interactionsPass) failureTags.push("interactions_failed");
  if (!input.criticPass) failureTags.push("critic_failed");
  if (!input.screenshotNonBlank) failureTags.push("blank_screenshot");
  return {
    ...input,
    passed: failureTags.length === 0,
    failureTags,
  };
}

export function buildWorkbenchSmokeResults(): WorkbenchEvalResult[] {
  return GOLDEN_OBJECTIVES.map((item, index) => scoreWorkbenchObjective({
    objectiveId: item.id,
    buildClean: true,
    interactionsPass: true,
    criticPass: true,
    screenshotNonBlank: true,
    attempts: 1 + (index % 2),
    costCents: 35 + index * 5,
    wallClockMs: 60_000 + index * 4_000,
  }));
}

export function buildWorkbenchEvalScorecard(results: WorkbenchEvalResult[]): WorkbenchEvalScorecard {
  const passed = results.filter((item) => item.passed).length;
  return {
    suite: "workbench",
    objectiveCount: results.length,
    passRate: passRate(passed, results.length),
    medianAttempts: roundMetric(median(results.map((item) => item.attempts)), 2),
    medianCostCents: roundMetric(median(results.map((item) => item.costCents)), 2),
    medianWallClockMs: roundMetric(median(results.map((item) => item.wallClockMs)), 0),
    objectives: results,
  };
}

export function meetsWorkbenchPassRateThreshold(scorecard: WorkbenchEvalScorecard, threshold: number): boolean {
  return scorecard.passRate >= threshold;
}
