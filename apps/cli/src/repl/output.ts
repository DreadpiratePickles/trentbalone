import chalk from "chalk";

export const ROLE_COLORS: Record<string, (text: string) => string> = {
  ceo: chalk.hex("#8B5CF6"),
  engineer: chalk.hex("#06B6D4"),
  "eng-ai-engineer": chalk.hex("#06B6D4"),
  growth: chalk.hex("#10B981"),
  content: chalk.hex("#F59E0B"),
  support: chalk.hex("#3B82F6"),
  "support-responder": chalk.hex("#3B82F6"),
  "sup-support-responder": chalk.hex("#3B82F6"),
  analyst: chalk.hex("#EC4899"),
  finance: chalk.hex("#EF4444"),
  browser: chalk.hex("#6366F1"),
  escalation: chalk.hex("#F97316"),
};

export function getRoleColor(agentId: string): (text: string) => string {
  const norm = agentId.toLowerCase().trim();
  return ROLE_COLORS[norm] || chalk.hex("#8B5CF6");
}

import { ASCII_LOGO } from "./ascii.js";

export function formatBanner(activeCount: number, model: string, provider: string): string {
  const purple = chalk.hex("#8B5CF6");
  const cyan = chalk.hex("#06B6D4");
  const dim = chalk.hex("#9CA3AF");

  return [
    ASCII_LOGO,
    purple("╔══════════════════════════════════════════════════════════════╗"),
    purple("║  ") +
      chalk.bold("Trent — AI Cofounder Fleet") +
      purple("         ") +
      cyan(`${activeCount} agent${activeCount === 1 ? "" : "s"} active`.padEnd(16, " ")) +
      purple("║"),
    purple("║  ") +
      dim(`Model: ${model} · Provider: ${provider}`.padEnd(56, " ")) +
      purple("║"),
    purple("╚══════════════════════════════════════════════════════════════╝"),
    "",
    chalk.dim("Type a message to chat with your cofounder, or type ") +
      chalk.cyan("/") +
      chalk.dim(" for slash commands."),
    "",
  ].join("\n");
}

export function formatAgentMessage(
  agentName: string,
  content: string,
  meta?: {
    file?: string;
    lines?: number;
    durationMs?: number;
    cost?: number;
    model?: string;
  }
): string {
  const colorFn = getRoleColor(agentName);
  const prefix = colorFn(`[${agentName}]`);
  const lines = [`${prefix} ${content}`];

  if (meta?.file) {
    lines.push(chalk.dim(`  📎 ${meta.file}${meta.lines ? ` · ${meta.lines} lines` : ""}`));
  }

  const footerParts: string[] = [];
  if (meta?.durationMs !== undefined) {
    footerParts.push(`⏱ ${(meta.durationMs / 1000).toFixed(1)}s`);
  }
  if (meta?.cost !== undefined) {
    footerParts.push(`💰 $${meta.cost.toFixed(2)}`);
  }
  if (meta?.model) {
    footerParts.push(`🤖 ${meta.model}`);
  }

  if (footerParts.length > 0) {
    lines.push(chalk.dim(`  ${footerParts.join(" · ")}`));
  }

  return lines.join("\n");
}

export function formatApprovalGate(
  agentName: string,
  action: string,
  details: Record<string, unknown>,
  meta?: { cost?: number; duration?: string }
): string {
  const yellow = chalk.hex("#F59E0B");
  const red = chalk.hex("#EF4444");
  const dim = chalk.hex("#9CA3AF");

  const detailLines = Object.entries(details)
    .map(([k, v]) => `  ${chalk.dim(`${k}:`)} ${String(v)}`)
    .join("\n");

  return [
    "",
    red.bold("┌─ ⚠ APPROVAL REQUIRED ─────────────────────────────────────────┐"),
    red.bold("│") + `  Agent wants to: ${yellow.bold(action)}`,
    red.bold("│") + `  Agent: ${chalk.bold(agentName)}`,
    red.bold("│"),
    detailLines,
    red.bold("│"),
    red.bold("│") +
      `  ${dim("Budget:")} ${meta?.cost ? `$${meta.cost.toFixed(2)}` : "$0.00"} · ${dim("Time:")} ${meta?.duration || "~30s"}`,
    red.bold("│") + `  Press ${chalk.green.bold("[y]")} to Approve, ${chalk.red.bold("[n]")} to Deny`,
    red.bold("└───────────────────────────────────────────────────────────────┘"),
    "",
  ].join("\n");
}

export function formatBudgetTicker(spent: number, cap: number): string {
  const pct = Math.round((spent / cap) * 100);
  let color = chalk.green;
  if (pct >= 80) color = chalk.red;
  else if (pct >= 50) color = chalk.yellow;

  return color(`💰 $${spent.toFixed(2)} / $${cap.toFixed(2)} today (${pct}%)`);
}
