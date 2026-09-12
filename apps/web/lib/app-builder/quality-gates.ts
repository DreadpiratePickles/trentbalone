export type QualityGateKind = "performance" | "accessibility" | "seo" | "i18n";

export type QualityGate = {
  kind: QualityGateKind;
  commands: string[];
  artifacts: string[];
  thresholds?: Record<string, number>;
  metadata?: Record<string, unknown>;
};

export type QualityGateManifest = {
  gates: QualityGate[];
};

export function createQualityGateManifest(input: {
  brandVoice?: string;
  locales?: string[];
}): QualityGateManifest {
  return {
    gates: [
      {
        kind: "performance",
        commands: ["npx lighthouse", "npm run build"],
        artifacts: ["lighthouse-report", "bundle-size-report"],
        thresholds: { lighthousePerformance: 80, maxFirstLoadKb: 250 },
      },
      {
        kind: "accessibility",
        commands: ["npx axe"],
        artifacts: ["axe-report"],
        thresholds: { criticalViolations: 0 },
      },
      {
        kind: "seo",
        commands: ["npm run build"],
        artifacts: ["sitemap.xml", "robots.txt", "og:image", "structured-data"],
      },
      {
        kind: "i18n",
        commands: ["npm test"],
        artifacts: ["locale-files", "translation-memory"],
        metadata: {
          brandVoice: input.brandVoice ?? "preserve company brand voice",
          locales: input.locales ?? ["en"],
        },
      },
    ],
  };
}

export function validateQualityGateManifest(manifest: QualityGateManifest) {
  const errors: string[] = [];
  const kinds = new Set(manifest.gates.map((gate) => gate.kind));
  for (const required of ["performance", "accessibility", "seo", "i18n"] satisfies QualityGateKind[]) {
    if (!kinds.has(required)) errors.push(`Missing ${required} gate`);
  }
  const performance = manifest.gates.find((gate) => gate.kind === "performance");
  const score = performance?.thresholds?.lighthousePerformance;
  if (score !== undefined && score < 80) errors.push("lighthousePerformance must be at least 80");
  return errors;
}
