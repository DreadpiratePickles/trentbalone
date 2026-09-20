/**
 * [U1] The `gate` block of `config.yaml`: the class floor below every autonomy level.
 *
 * A tool call classified `external_send`, `money_moving` or `customer_facing`
 * (`policy-rules.ts` classifyCall) is a post, a send, a booking, an invoice or a charge. Such a
 * call asks a human at EVERY level — `autonomy: never` cannot lift it — and the approval is bound
 * to the exact call (`bound-approvals.ts`). The shipped classes are a constant, not a key: a floor
 * a config key could lower is not a floor. `ask_classes` can only add to it.
 *
 * Defined beside the code that enforces it (`autonomy.ts`, `autonomy-dispatch.ts`) and composed
 * into `config/schema.ts` by one marked line, the way `checkpoints` and `goals` are.
 */
import { z } from "zod";
import { PolicyClassSchema, type PolicyClass } from "./policy-rules.js";

/** The classes a human approves at every autonomy level. Shipped; nothing removes one. */
export const CLASS_FLOOR: readonly PolicyClass[] = ["external_send", "money_moving", "customer_facing"];

export const GateConfigSchema = z
  .object({
    /** Classes added to the shipped floor. A class already on the floor is accepted and ignored. */
    ask_classes: z.array(PolicyClassSchema).default([]),
  })
  .strict();

export type GateConfig = z.infer<typeof GateConfigSchema>;

export const DEFAULT_GATE_CONFIG: GateConfig = { ask_classes: [] };

/** The floor a build enforces: the shipped classes, then whatever the profile adds, without repeats. */
export function floorClasses(config?: Partial<GateConfig>): PolicyClass[] {
  return [...new Set<PolicyClass>([...CLASS_FLOOR, ...(config?.ask_classes ?? [])])];
}
