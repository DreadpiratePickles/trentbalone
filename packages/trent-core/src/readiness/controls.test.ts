import { describe, it, expect } from "vitest";
import {
  READINESS_CONTROLS,
  REQUIRED_READINESS_CONTROL_SLUGS,
  readinessControlBySlug,
} from "./index.js";

describe("readiness wrapper — the required-control registry", () => {
  it("has one control for every required slug and no extras", () => {
    expect(REQUIRED_READINESS_CONTROL_SLUGS).toHaveLength(READINESS_CONTROLS.length);
    expect([...REQUIRED_READINESS_CONTROL_SLUGS].sort()).toEqual(
      READINESS_CONTROLS.map((c) => c.slug).sort(),
    );
  });

  it("resolves every required slug to a control carrying at least one evidence entry", () => {
    for (const slug of REQUIRED_READINESS_CONTROL_SLUGS) {
      const control = readinessControlBySlug(slug);
      expect(control, `no control for ${slug}`).toBeDefined();
      expect(control!.slug).toBe(slug);
      expect(control!.evidence.length, `no evidence for ${slug}`).toBeGreaterThan(0);
      expect(control!.nextAction.length).toBeGreaterThan(0);
    }
  });

  it("returns undefined for an unknown slug", () => {
    expect(readinessControlBySlug("not-a-control")).toBeUndefined();
  });
});
