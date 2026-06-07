import { describe, expect, it } from "vitest";
import { artifactToCsv, artifactToHtml, buildArtifactDraft, inferArtifactRequest } from "@/lib/artifacts";
import { artifactToPdf, artifactToXlsx } from "@/lib/artifact-exporters";
import { store } from "@/lib/store";

describe("artifact builder", () => {
  it("infers artifact requests from founder commands", () => {
    const request = inferArtifactRequest("Build a competitive research PDF for Trent");
    expect(request?.type).toBe("competitive_research");
    expect(request?.createdByAgent).toBe("analyst");
  });

  it("builds, persists, and exports an artifact", async () => {
    const company = await store.createCompany({
      name: "Artifact Test Co",
      brief: {
        vision: "Build investor-ready operating artifacts",
        competitors: "Viktor, a competing product, Claude, Codex"
      }
    });
    const draft = buildArtifactDraft({
      company,
      prompt: "Build a competitive research artifact",
      type: "competitive_research",
      tasks: [],
      cycles: [],
      documents: [],
      reports: []
    });

    const artifact = await store.createArtifact(draft);

    expect(artifact.id).toContain("artifact");
    expect(artifact.status).toBe("ready");
    expect(artifact.provenance.sources).toContain("company operating brief");
    expect(artifactToHtml(artifact)).toContain("<html>");
    expect(artifactToCsv(artifact)).toContain("Competitive Research");
    expect(artifactToPdf(artifact).subarray(0, 8).toString("utf8")).toBe("%PDF-1.4");
    expect(artifactToXlsx(artifact).subarray(0, 4).toString("hex")).toBe("504b0304");
  });
});
