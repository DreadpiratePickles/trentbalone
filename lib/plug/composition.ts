import type { PlugDefinition } from "@/lib/plug/schema-v2";

export function composePlugs(plugs: PlugDefinition[], options: { maxDepth: number; budgetCents: number }) {
  if (plugs.length > options.maxDepth) throw new Error("Plug pipeline depth exceeds cap");
  const totalBudget = plugs.reduce((sum, plug) => sum + plug.costPerRunCents, 0);
  if (totalBudget > options.budgetCents) throw new Error("Plug pipeline exceeds budget");
  return {
    totalBudget,
    handoffs: plugs.slice(0, -1).map((plug, index) => ({
      fromPlugId: plug.id,
      toPlugId: plugs[index + 1].id,
      contractVersion: plug.version,
    })),
  };
}
