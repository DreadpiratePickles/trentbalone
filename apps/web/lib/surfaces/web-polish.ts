export function createWebPolishPlan(input: { routes: string[]; dataSources: string[] }) {
  return {
    routes: input.routes,
    realDataSources: input.dataSources,
    mockDataAllowed: false,
    performanceBudgets: {
      lcpMs: 2500,
      inpMs: 200,
      cls: 0.1,
      routeJsKb: 180,
    },
    accessibilityChecks: ["keyboard_navigation", "focus_states", "aria_labels", "color_contrast"],
    freshnessTargets: {
      approvalsSeconds: 15,
      activitySeconds: 30,
      usageSeconds: 60,
    },
  };
}
