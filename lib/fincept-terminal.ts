export const FINCEPT_TERMINAL_SCOPES = [
  "fincept:launch_sandbox",
  "fincept:market_research",
  "fincept:portfolio_analysis",
  "fincept:risk_report",
  "fincept:economic_data",
  "fincept:paper_trading",
];

export type FinceptTerminalAction =
  | "launch_sandbox"
  | "market_research"
  | "portfolio_analysis"
  | "risk_report"
  | "economic_data"
  | "paper_trading";

export function buildFinceptTerminalToolScopes() {
  return [...FINCEPT_TERMINAL_SCOPES];
}

export function isFinceptTerminalAction(action: string): action is FinceptTerminalAction {
  return [
    "launch_sandbox",
    "market_research",
    "portfolio_analysis",
    "risk_report",
    "economic_data",
    "paper_trading",
  ].includes(action);
}

export function buildFinceptTerminalCommandPlan(action: FinceptTerminalAction, payload: Record<string, unknown>) {
  const args = ["fincept-terminal", "--sandbox", action.replaceAll("_", "-")];

  const symbol = typeof payload.symbol === "string" ? payload.symbol : typeof payload.ticker === "string" ? payload.ticker : undefined;
  if (symbol) args.push("--symbol", symbol);

  const portfolio = typeof payload.portfolio === "string" ? payload.portfolio : undefined;
  if (portfolio) args.push("--portfolio", portfolio);

  const output = typeof payload.output === "string" ? payload.output : undefined;
  if (output) args.push("--output", output);

  return {
    command: args[0],
    args: args.slice(1),
    sandbox: true,
  };
}

export function formatFinceptTerminalCommand(plan: ReturnType<typeof buildFinceptTerminalCommandPlan>) {
  return [plan.command, ...plan.args].join(" ");
}
