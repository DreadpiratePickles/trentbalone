import { describe, expect, it } from "vitest";
import {
  buildHyperFramesCommandPlan,
  buildHyperFramesToolScopes,
  getHyperFramesConfig,
} from "@/lib/hyperframes";

describe("HyperFrames integration helpers", () => {
  it("declares the safe tool scopes Trent grants to the growth seat", () => {
    expect(buildHyperFramesToolScopes()).toEqual([
      "hyperframes:create",
      "hyperframes:catalog",
      "hyperframes:preview",
      "hyperframes:lint",
      "hyperframes:inspect",
      "hyperframes:render",
    ]);
  });

  it("keeps command execution disabled unless explicitly enabled", () => {
    expect(getHyperFramesConfig({})).toEqual({
      executionEnabled: false,
      workspaceRoot: process.cwd(),
    });
    expect(getHyperFramesConfig({ HYPERFRAMES_EXECUTION: "enabled", HYPERFRAMES_WORKSPACE_ROOT: "/tmp/hf" })).toEqual({
      executionEnabled: true,
      workspaceRoot: "/tmp/hf",
    });
  });

  it("builds non-interactive command plans for common CLI actions", () => {
    expect(buildHyperFramesCommandPlan("create", { projectName: "launch-video", template: "product-promo" })).toEqual([
      "npx",
      "hyperframes",
      "init",
      "launch-video",
      "--example",
      "product-promo",
      "--non-interactive",
    ]);
    expect(buildHyperFramesCommandPlan("render", { output: "renders/final.mp4", quality: "draft" })).toEqual([
      "npx",
      "hyperframes",
      "render",
      "--output",
      "renders/final.mp4",
      "--quality",
      "draft",
    ]);
  });
});
