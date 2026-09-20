/**
 * [X5] The `agent` block of `config.yaml`: how many times a step that failed on a transient
 * provider or tool error is run again before the run reports the failure.
 *
 * `auto_recovery_cycles` is the number of RE-RUNS, not attempts: 1 (the shipped default) means a
 * step gets one more go with the previous error appended to its prompt; 0 turns recovery off. It
 * sits above the gateway's own per-call retry (`model-gateway/retry.ts`), which has already spent
 * its attempts by the time a step fails, and it never applies to an approval park, a budget stop,
 * a refusal or a non-transient error (`orchestrator/auto-recovery.ts`, docs/jobs.md).
 *
 * The block is NOT strict, and the key has no schema default: `agent` was a passthrough key
 * before this schema existed, and the setup wizard writes `agent.disabled_toolsets` into it
 * (`setup/steps.ts`), so a strict object would refuse every profile that ran setup, and a
 * required key would make that writer's type fail. A profile written before X5 parses without
 * the key and gets the orchestrator's default (`DEFAULT_AUTO_RECOVERY_CYCLES`); a fresh profile
 * gets it written by `DEFAULT_CONFIG`.
 *
 * Defined beside the hook that reads it and composed into `config/schema.ts` by one marked
 * block, the way `gate`, `goals`, `retrieval` and `checkpoints` are.
 */
import { z } from "zod";
import { DEFAULT_AUTO_RECOVERY_CYCLES } from "./auto-recovery.js";

export const RecoveryConfigSchema = z
  .object({
    /** Re-runs of a step after a transient error; 0 turns auto-recovery off; absent means the orchestrator's default. */
    auto_recovery_cycles: z.number().int().min(0).optional(),
  })
  .passthrough();

export type RecoveryConfig = z.infer<typeof RecoveryConfigSchema>;

export const RECOVERY_DEFAULTS: RecoveryConfig = { auto_recovery_cycles: DEFAULT_AUTO_RECOVERY_CYCLES };
