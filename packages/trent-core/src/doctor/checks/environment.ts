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

/** `a`, `a and b`, `a, b and c`. */
function listNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The fix for exactly the variables that are wrong. Each violation line starts with its variable's
 * name (`runtime/env.ts`). Since 499cd14 the CLI sets `TRENT_QUEUE_FALLBACK=disabled` itself when
 * it is unset (`apps/cli/src/env-defaults.ts`), so a queue violation means an explicit other value:
 * unsetting it is as good as setting it, and "export" was advice for a step that no longer exists.
 */
function fixHintFor(violations: readonly string[]): string {
  const names = violations.map((line) => line.split(/\s/)[0] ?? "").filter((name) => name !== "");
  const parts: string[] = [];
  if (names.includes("TRENT_QUEUE_FALLBACK")) parts.push("unset TRENT_QUEUE_FALLBACK or set it to disabled (the CLI sets disabled itself when it is unset)");
  const unset = names.filter((name) => name !== "TRENT_QUEUE_FALLBACK");
  if (unset.length > 0) parts.push(`unset ${listNames(unset)}`);
  const hint = parts.join(", and ");
  return `${hint.charAt(0).toUpperCase()}${hint.slice(1)} before running Trent.`;
}

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
        fixHint: fixHintFor(violations),
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
