import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMorningOutcomeSnapshot } from "@/lib/morning-outcome-snapshot";
import type { Company } from "@/lib/types";

function company(): Company {
  return {
    id: "co_snapshot_test",
    name: "Trench OS",
    metrics: { users: 120, signups: 30, revenueCents: 420000 },
  } as Company;
}

const POSTHOG_KEYS = ["POSTHOG_PERSONAL_API_KEY", "POSTHOG_API_KEY", "POSTHOG_PROJECT_ID", "POSTHOG_TEAM_ID", "GA_PROPERTY_ID"];

describe("morning outcome snapshot", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of POSTHOG_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of POSTHOG_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("reports PostHog analytics as not configured without credentials", async () => {
    const snapshot = await buildMorningOutcomeSnapshot({ company: company(), usage: [], approvals: [], env: {} as NodeJS.ProcessEnv });
    expect(snapshot.some((line) => line === "- PostHog analytics: not configured")).toBe(true);
  });

  it("reports PostHog analytics as connected when analytics credentials exist", async () => {
    const env = { POSTHOG_PERSONAL_API_KEY: "phx_test", POSTHOG_PROJECT_ID: "1" } as unknown as NodeJS.ProcessEnv;
    const snapshot = await buildMorningOutcomeSnapshot({ company: company(), usage: [], approvals: [], env });
    expect(snapshot.some((line) => line === "- PostHog analytics: connected")).toBe(true);
  });

  it("still includes the Stripe and Sentry lines", async () => {
    const snapshot = await buildMorningOutcomeSnapshot({ company: company(), usage: [], approvals: [], env: {} as NodeJS.ProcessEnv });
    expect(snapshot.some((line) => line.startsWith("- Stripe billing:"))).toBe(true);
    expect(snapshot.some((line) => line.startsWith("- Sentry errors:"))).toBe(true);
  });
});
