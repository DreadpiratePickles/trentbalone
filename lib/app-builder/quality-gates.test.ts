import { describe, expect, it } from "vitest";
import { createQualityGateManifest, validateQualityGateManifest } from "./quality-gates";

describe("app builder quality gates", () => {
  it("creates performance, accessibility, SEO, and i18n gate manifests", () => {
    const manifest = createQualityGateManifest({
      brandVoice: "clear, direct, founder-led",
      locales: ["en", "es"],
    });

    expect(manifest.gates.map((gate) => gate.kind)).toEqual(["performance", "accessibility", "seo", "i18n"]);
    expect(manifest.gates.find((gate) => gate.kind === "performance")?.commands).toContain("npx lighthouse");
    expect(manifest.gates.find((gate) => gate.kind === "accessibility")?.commands).toContain("npx axe");
    expect(manifest.gates.find((gate) => gate.kind === "seo")?.artifacts).toEqual(["sitemap.xml", "robots.txt", "og:image", "structured-data"]);
    expect(manifest.gates.find((gate) => gate.kind === "i18n")?.metadata).toEqual(expect.objectContaining({
      brandVoice: "clear, direct, founder-led",
      locales: ["en", "es"],
    }));
  });

  it("validates required gates and budget thresholds", () => {
    const manifest = createQualityGateManifest({});
    expect(validateQualityGateManifest(manifest)).toEqual([]);
    manifest.gates[0]!.thresholds!.lighthousePerformance = 40;
    expect(validateQualityGateManifest(manifest)).toContain("lighthousePerformance must be at least 80");
  });
});
