/**
 * A2.1 on the surface: how a workspace's instruction files are worded for the stable tier, and what
 * the user is told about the ones that were not loaded.
 *
 * The trust decision, the prompt-injection scan and the caps belong to
 * `@trent/core/workspace-context` and are proved there. What is under test here is the wording and
 * the absence of a block when there is nothing to say.
 */

import { describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@trent/core/workspace-context/index.js";
import { renderWorkspaceContext, workspaceNotices } from "../workspace.js";

const ROOT = "/tmp/a-workspace";

function context(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    trusted: true,
    blocks: [],
    refused: [],
    workspaceRoot: ROOT,
    instruction: null,
    contentHash: "hash",
    changedSinceTrusted: false,
    ...overrides,
  };
}

describe("the workspace block the stable tier carries", () => {
  it("renders every loaded file under the workspace root, in the order the loader returned them", () => {
    const rendered = renderWorkspaceContext(
      context({
        blocks: [
          { path: "AGENTS.md", content: "apps/web is read only.", chars: 22 },
          { path: ".trent/house.md", content: "Money is integer cents.", chars: 23 },
        ],
      }),
    );
    expect(rendered).toContain(ROOT);
    expect(rendered).toContain("AGENTS.md");
    expect(rendered).toContain("apps/web is read only.");
    expect(rendered).toContain(".trent/house.md");
    expect(rendered?.indexOf("AGENTS.md")).toBeLessThan(rendered?.indexOf(".trent/house.md") ?? 0);
  });

  it("is absent — not empty — for an untrusted workspace and for a trusted one with no files", () => {
    expect(renderWorkspaceContext(context({ trusted: false, instruction: "trust it" }))).toBeUndefined();
    expect(renderWorkspaceContext(context())).toBeUndefined();
  });
});

describe("what the surface says about the workspace", () => {
  it("shows the loader's own instruction, and nothing else, when the workspace is untrusted", () => {
    const instruction = `This workspace is not trusted. Run: trent workspace trust ${ROOT}`;
    expect(workspaceNotices(context({ trusted: false, instruction }))).toEqual([instruction]);
  });

  it("names every refused file and its reason, one line each", () => {
    const lines = workspaceNotices(
      context({
        blocks: [{ path: "AGENTS.md", content: "fine", chars: 4 }],
        refused: [
          { path: "CLAUDE.md", reason: "prompt injection scan: instruction_override: it tells the model to ignore its rules" },
          { path: ".trent/big.md", reason: "workspace.max_total_chars (24000) was already spent, so this file was not loaded" },
        ],
      }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("CLAUDE.md");
    expect(lines[0]).toContain("prompt injection scan");
    expect(lines[1]).toContain(".trent/big.md");
  });

  it("says nothing at all when every file loaded", () => {
    expect(workspaceNotices(context({ blocks: [{ path: "AGENTS.md", content: "fine", chars: 4 }] }))).toEqual([]);
  });
});
