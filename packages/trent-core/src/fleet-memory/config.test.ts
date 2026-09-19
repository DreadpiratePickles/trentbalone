/**
 * [C4] The recall budget comes from configuration, not from an environment variable.
 *
 * `TRENT_FLEET_RECALL_BUDGET_CHARS` was advertised in this module's README and read by
 * `resolveFleetMemoryConfig`, which nothing ever called — the hook used the defaults directly
 * (fleet audit 3.3, 3.7). An operator who set it got no change and no warning. The reader is gone;
 * the helper stays as the one place a caller merges overrides onto the shipped defaults.
 */
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_FLEET_MEMORY_CONFIG, resolveFleetMemoryConfig } from "./config.js";

const ENV_NAME = "TRENT_FLEET_RECALL_BUDGET_CHARS";
const before = process.env[ENV_NAME];

afterEach(() => {
  if (before === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = before;
});

describe("resolveFleetMemoryConfig", () => {
  it("returns the shipped defaults with no overrides", () => {
    expect(resolveFleetMemoryConfig()).toEqual(DEFAULT_FLEET_MEMORY_CONFIG);
  });

  it("applies an override and leaves every other budget alone", () => {
    const resolved = resolveFleetMemoryConfig({ recallBudgetChars: 700 });
    expect(resolved.recallBudgetChars).toBe(700);
    expect(resolved.searchDefaultLimit).toBe(DEFAULT_FLEET_MEMORY_CONFIG.searchDefaultLimit);
  });

  it("ignores the environment variable that used to be advertised and never worked", () => {
    process.env[ENV_NAME] = "99";
    expect(resolveFleetMemoryConfig().recallBudgetChars).toBe(DEFAULT_FLEET_MEMORY_CONFIG.recallBudgetChars);
  });
});
