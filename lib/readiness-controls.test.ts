import { describe, expect, it } from "vitest";
import {
  READINESS_CONTROLS,
  REQUIRED_READINESS_CONTROL_SLUGS,
  readinessControlBySlug,
} from "./readiness-controls";

describe("readiness controls", () => {
  it("covers every requested checklist item exactly once", () => {
    const slugs = READINESS_CONTROLS.map((control) => control.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.sort()).toEqual([...REQUIRED_READINESS_CONTROL_SLUGS].sort());
  });

  it("has usable evidence and next actions for every control", () => {
    for (const control of READINESS_CONTROLS) {
      expect(control.label.trim(), control.slug).not.toBe("");
      expect(control.why.trim(), control.slug).not.toBe("");
      expect(control.evidence.length, control.slug).toBeGreaterThan(0);
      expect(control.evidence.every((line) => line.trim().length > 12), control.slug).toBe(true);
      expect(control.nextAction.trim().length, control.slug).toBeGreaterThan(20);
    }
  });

  it("keeps external/incomplete controls explicit", () => {
    const incomplete = READINESS_CONTROLS.filter((control) => control.status !== "enforced");
    expect(incomplete.length).toBeGreaterThan(0);
    expect(incomplete.every((control) => !/done|complete|finished/i.test(control.nextAction))).toBe(true);
  });

  it("can look up controls by slug", () => {
    expect(readinessControlBySlug("authentication")?.status).toBe("enforced");
    expect(readinessControlBySlug("not-real")).toBeUndefined();
  });
});
