import { describe, expect, it } from "vitest";
import { isWorkspaceUnscaffolded } from "@/lib/workbench-build-loop";
import { PREVIEW_PID_FILENAME } from "@/lib/workbench-preview-reaper";

describe("isWorkspaceUnscaffolded", () => {
  it("treats an empty workspace as unscaffolded", () => {
    expect(isWorkspaceUnscaffolded([])).toBe(true);
  });

  it("ignores the session README written by provider start()", () => {
    // Regression: mock_local/railway start() writes README.md into every new
    // session workdir, which used to make the workspace look non-empty and
    // silently skip starter-template seeding (no package.json/tsconfig.json/
    // index.html -> tsc help screen, vite 404).
    expect(isWorkspaceUnscaffolded([{ name: "README.md", isDir: false }])).toBe(true);
  });

  it("ignores the preview pid sidecar and .DS_Store", () => {
    expect(isWorkspaceUnscaffolded([
      { name: "README.md", isDir: false },
      { name: PREVIEW_PID_FILENAME, isDir: false },
      { name: ".DS_Store", isDir: false },
    ])).toBe(true);
  });

  it("keeps a scaffolded workspace untouched once project files exist", () => {
    expect(isWorkspaceUnscaffolded([
      { name: "README.md", isDir: false },
      { name: "package.json", isDir: false },
    ])).toBe(false);
    expect(isWorkspaceUnscaffolded([{ name: "src", isDir: true }])).toBe(false);
  });
});
