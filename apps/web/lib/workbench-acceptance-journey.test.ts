import { describe, expect, it } from "vitest";
import { deriveAcceptanceJourney } from "@/lib/workbench-acceptance-journey";

describe("deriveAcceptanceJourney", () => {
  it("derives a type → add → assert journey for list/todo apps", () => {
    const steps = deriveAcceptanceJourney("Build a todo app where I can add tasks");
    expect(steps).toHaveLength(2);
    expect(steps[0].action).toMatch(/^type '.+' in input$/);
    expect(steps[1].action).toBe("click first visible button");
    // The added item must actually appear in the DOM.
    expect(steps[1].expect).toMatch(/visible text includes '.+'/);
    // The probe token is consistent between typing and asserting.
    const typed = steps[0].action.match(/type '(.+)' in input/)![1];
    expect(steps[1].expect).toContain(typed);
  });

  it("uses a single responsive-click step for counters", () => {
    const steps = deriveAcceptanceJourney("a click counter app");
    expect(steps).toHaveLength(1);
    expect(steps[0].action).toBe("click first visible button");
    expect(steps[0].expect).toMatch(/responds|DOM change|network/);
  });

  it("falls back to the smoke step for generic / marketing pages", () => {
    const landing = deriveAcceptanceJourney("Build a landing page for my agency");
    expect(landing).toHaveLength(1);
    expect(landing[0].action).toBe("click first visible button");
  });

  it("recognises notes apps as list interactions", () => {
    const steps = deriveAcceptanceJourney("a notes app that saves notes");
    expect(steps).toHaveLength(2);
  });
});
