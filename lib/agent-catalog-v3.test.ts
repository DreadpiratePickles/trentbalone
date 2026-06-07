import { describe, expect, it } from "vitest";
import { getCatalogAgent, getCatalogAgentV3 } from "@/lib/agent-catalog";
import { getAgentRuntime } from "@/lib/agent-runtime";

describe("agent catalog v3 metadata", () => {
  it("exposes improved Plug Schema v3 metadata for replacement agents", () => {
    const agent = getCatalogAgentV3("eng-code-reviewer");

    expect(agent?.whenNotToUse).toContain("Greenfield");
    expect(agent?.specialistPrompt).toContain("Review in strict priority order");
    expect(agent?.evalSuite?.capability.length).toBeGreaterThanOrEqual(3);
    expect(agent?.reversibilityMatrix?.irreversible).toContain("github_merge_pr");
    expect(getCatalogAgent("eng-code-reviewer")?.name).toContain("Code Reviewer");
  });

  it("injects specialist prompt and supervision metadata into runtime", async () => {
    const runtime = await getAgentRuntime("co_1", "engineer");

    expect(runtime.systemPrompt).toContain("Slot mission");
    expect(runtime.availableV3Profiles?.some((profile) => profile.id === "eng-code-reviewer")).toBe(true);
  });
});
