export type CeoChatMode = "org" | "gen";

export function normalizeCeoChatMode(value: unknown): CeoChatMode {
  return value === "gen" ? "gen" : "org";
}
