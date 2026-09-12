import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";
import { assertStandaloneEnv, standaloneEnvKeys } from "../../runtime/env.js";

/**
 * The environment contract, checked with the same function the runtime uses, so there is exactly one
 * definition of what "safe" means. The failure message states the consequence rather than the rule:
 * without `TRENT_QUEUE_FALLBACK=disabled` the inline fallback races the CLI's own drain loop and
 * every job executes twice, silently, roughly quadrupling the model bill while still reporting
 * success.
 */

const CATEGORY = "Environment";
const NAME = "Standalone Environment Contract";

export const DOUBLE_EXECUTION_CONSEQUENCE =
  "every job runs twice, silently, roughly quadrupling the model bill while the run still reports success";

export const checkEnvironment: DoctorCheck = {
  id: "check_environment",
  name: NAME,
  category: CATEGORY,
  async run(_ctx: DoctorContext): Promise<CheckResult> {
    // Names only. `standaloneEnvKeys` never reads a value, and neither does this check.
    const inspected = [...standaloneEnvKeys()];

    try {
      assertStandaloneEnv();
    } catch (err) {
      // The thrown message lists variable names and rules only; it never contains a value.
      const violations = (err as Error).message
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/^\s*-\s*/, ""))
        .filter(Boolean);

      return {
        category: CATEGORY,
        name: NAME,
        status: "fail",
        message: `The standalone environment contract is violated (${violations.join("; ")}). Consequence: ${DOUBLE_EXECUTION_CONSEQUENCE}.`,
        fixHint:
          "Export TRENT_QUEUE_FALLBACK=disabled and unset TRENT_EVAL_SYNC_QUEUE, REDIS_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN before running Trent.",
        details: { inspected, violations },
      };
    }

    return {
      category: CATEGORY,
      name: NAME,
      status: "ok",
      message: "Standalone environment contract holds: the queue fallback is disabled and no Redis variable is set.",
      details: { inspected },
    };
  },
};
