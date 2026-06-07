export type SupervisionRiskClass = "reversible" | "costly" | "irreversible";
export type SupervisionReversibility = "fully_reversible" | "costly_to_reverse" | "not_reversible";
export type SupervisionSideEffect =
  | "internal_state_change"
  | "external_api_call"
  | "spends_money"
  | "publishes_content"
  | "sends_message"
  | "changes_permissions"
  | "deploys_code"
  | "delete_data";

const COSTLY_EFFECTS: SupervisionSideEffect[] = [
  "spends_money",
  "publishes_content",
  "sends_message",
  "changes_permissions",
  "deploys_code",
];

export type ActionRiskInput = {
  sideEffects?: SupervisionSideEffect[];
  hasRollback?: boolean;
};

export type ActionRiskRating = {
  riskClass: SupervisionRiskClass;
  reversibility: SupervisionReversibility;
  reasons: string[];
};

export function rateActionRisk(input: ActionRiskInput): ActionRiskRating {
  const sideEffects = input.sideEffects ?? [];
  if (sideEffects.includes("delete_data") || !input.hasRollback) {
    return {
      riskClass: sideEffects.includes("delete_data") ? "irreversible" : "costly",
      reversibility: sideEffects.includes("delete_data") ? "not_reversible" : "costly_to_reverse",
      reasons: sideEffects.includes("delete_data")
        ? ["Action deletes data and has no guaranteed undo path."]
        : ["Action has no automated rollback path."],
    };
  }

  const costly = sideEffects.some((effect) => COSTLY_EFFECTS.includes(effect));
  if (costly) {
    return {
      riskClass: "costly",
      reversibility: "costly_to_reverse",
      reasons: ["Action can be rolled back but may leave external, money, or user-visible effects."],
    };
  }

  return {
    riskClass: "reversible",
    reversibility: "fully_reversible",
    reasons: ["Action has an automated rollback path and only low-risk side effects."],
  };
}
