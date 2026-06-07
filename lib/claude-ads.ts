export type ClaudeAdsAction =
  | "audit"
  | "google"
  | "meta"
  | "youtube"
  | "linkedin"
  | "tiktok"
  | "microsoft"
  | "apple"
  | "amazon"
  | "attribution"
  | "tracking"
  | "creative"
  | "budget"
  | "landing"
  | "report";

export type ClaudeAdsPayload = {
  platform?: string;
  businessType?: string;
  output?: string;
};

const PLATFORM_ACTIONS = new Set<ClaudeAdsAction>([
  "google",
  "meta",
  "youtube",
  "linkedin",
  "tiktok",
  "microsoft",
  "apple",
  "amazon",
]);

export function buildClaudeAdsToolScopes() {
  return [
    "claude_ads:audit",
    "claude_ads:platform_review",
    "claude_ads:creative_review",
    "claude_ads:budget_review",
    "claude_ads:landing_review",
    "claude_ads:report",
  ];
}

export function normalizeClaudeAdsAction(action: string): ClaudeAdsAction {
  const lower = action.toLowerCase();
  for (const platform of PLATFORM_ACTIONS) {
    if (lower.includes(platform)) return platform;
  }
  if (lower.includes("creative") || lower.includes("fatigue")) return "creative";
  if (lower.includes("budget") || lower.includes("bid") || lower.includes("allocation")) return "budget";
  if (lower.includes("landing")) return "landing";
  if (lower.includes("attribution")) return "attribution";
  if (lower.includes("tracking") || lower.includes("capi") || lower.includes("pixel")) return "tracking";
  if (lower.includes("report")) return "report";
  return "audit";
}

export function buildClaudeAdsCommandPlan(action: string, payload: ClaudeAdsPayload = {}) {
  const normalized = normalizeClaudeAdsAction(action);
  const platformAction = payload.platform ? normalizeClaudeAdsAction(payload.platform) : undefined;
  const command = ["/ads", platformAction && PLATFORM_ACTIONS.has(platformAction) ? platformAction : normalized];

  if (payload.businessType) command.push("--business-type", payload.businessType);
  if (payload.output) command.push("--output", payload.output);

  return command;
}

export function formatClaudeAdsCommand(command: string[]) {
  return command.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
}
