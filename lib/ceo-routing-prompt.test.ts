import { describe, expect, it } from "vitest";
import { buildCeoChatSystemPrompt } from "@/lib/ai";

describe("CEO chat routing prompt", () => {
  it("injects the full seat dossier, runtime environments, and owner-message routing hint", () => {
    const prompt = buildCeoChatSystemPrompt({
      company: {
        id: "co_1",
        name: "Routing Co",
        brief: { vision: "route work correctly" },
      } as any,
      ceoRuntimeSystemPrompt: "CEO runtime prompt",
      ownerMessage: "Use HyperFrames to create a launch video.",
      context: {
        tasks: [],
        documents: [],
        reports: [],
      },
    });

    expect(prompt).toContain("CEO runtime prompt");
    expect(prompt).toContain("CEO routing dossier");
    expect(prompt).toContain("HyperFrames");
    expect(prompt).toContain("Fincept Terminal");
    expect(prompt).toContain("Steel Browser");
    expect(prompt).toContain("Recommended route for this owner message: growth via HyperFrames");
  });
});
