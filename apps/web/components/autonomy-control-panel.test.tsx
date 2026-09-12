import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutonomyModeExplainer, MODE_RISK } from "@/components/autonomy-control-panel";

describe("AutonomyModeExplainer", () => {
  it("renders an honest risk explanation per mode", () => {
    for (const mode of ["manual", "supervised", "autonomous"] as const) {
      const html = renderToStaticMarkup(<AutonomyModeExplainer mode={mode} />);
      expect(html).toContain(`data-mode="${mode}"`);
      expect(html).toContain(MODE_RISK[mode].slice(0, 24));
    }
  });

  it("marks supervised as the default and never describes autonomous as unconditional", () => {
    expect(MODE_RISK.supervised).toContain("default");
    expect(MODE_RISK.autonomous.toLowerCase()).toContain("gated");
  });
});
