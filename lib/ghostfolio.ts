export const GHOSTFOLIO_SCOPES = [
  "ghostfolio:launch_sandbox",
  "ghostfolio:portfolio_overview",
  "ghostfolio:holdings_import",
  "ghostfolio:allocation_report",
  "ghostfolio:performance_report",
  "ghostfolio:risk_insights",
  "ghostfolio:fire_projection",
];

export type GhostfolioAction =
  | "launch_sandbox"
  | "portfolio_overview"
  | "holdings_import"
  | "allocation_report"
  | "performance_report"
  | "risk_insights"
  | "fire_projection";

export function buildGhostfolioToolScopes() {
  return [...GHOSTFOLIO_SCOPES];
}

export function isGhostfolioAction(action: string): action is GhostfolioAction {
  return [
    "launch_sandbox",
    "portfolio_overview",
    "holdings_import",
    "allocation_report",
    "performance_report",
    "risk_insights",
    "fire_projection",
  ].includes(action);
}

export function buildGhostfolioCommandPlan(action: GhostfolioAction, payload: Record<string, unknown>) {
  const args = ["ghostfolio", "--sandbox", action.replaceAll("_", "-")];

  const portfolio = typeof payload.portfolio === "string" ? payload.portfolio : undefined;
  if (portfolio) args.push("--portfolio", portfolio);

  const symbol = typeof payload.symbol === "string" ? payload.symbol : typeof payload.ticker === "string" ? payload.ticker : undefined;
  if (symbol) args.push("--symbol", symbol);

  const input = typeof payload.input === "string" ? payload.input : undefined;
  if (input) args.push("--input", input);

  const output = typeof payload.output === "string" ? payload.output : undefined;
  if (output) args.push("--output", output);

  return {
    command: args[0],
    args: args.slice(1),
    sandbox: true,
  };
}

export function formatGhostfolioCommand(plan: ReturnType<typeof buildGhostfolioCommandPlan>) {
  return [plan.command, ...plan.args].join(" ");
}
