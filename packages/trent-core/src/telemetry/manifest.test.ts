import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeRunManifest, readRunManifest, RUN_MANIFEST_VERSION } from "./manifest.js";

describe("run manifest writer", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-manifest-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes input versions, reference versions, outputs and the verifier result", () => {
    const p = writeRunManifest(path.join(dir, "run_1"), {
      runId: "run_1",
      stage: "implement",
      inputVersions: { "docs/spec.md": "sha256:aaa", "config.yaml": "sha256:bbb" },
      referenceVersions: { "@trent/core": "0.2.0", node: "22.11.0" },
      outputPaths: ["packages/trent-core/src/telemetry/manifest.ts"],
      verifier: { name: "vitest", passed: true, exitCode: 0, detail: "42 passed" },
    });

    expect(fs.existsSync(p)).toBe(true);
    const m = readRunManifest(p);
    expect(m.manifestVersion).toBe(RUN_MANIFEST_VERSION);
    expect(m.runId).toBe("run_1");
    expect(m.inputVersions["docs/spec.md"]).toBe("sha256:aaa");
    expect(m.referenceVersions.node).toBe("22.11.0");
    expect(m.outputPaths).toHaveLength(1);
    expect(m.verifier?.passed).toBe(true);
    expect(m.verifier?.exitCode).toBe(0);
    expect(typeof m.createdAt).toBe("string");
  });

  it("writes the manifest 0600 inside a 0700 directory", () => {
    const p = writeRunManifest(path.join(dir, "run_2"), {
      runId: "run_2",
      inputVersions: {},
      referenceVersions: {},
      outputPaths: [],
    });
    expect((fs.statSync(p).mode & 0o777).toString(8)).toBe("600");
    expect((fs.statSync(path.dirname(p)).mode & 0o777).toString(8)).toBe("700");
  });

  it("redacts secret-shaped values that leak into manifest detail", () => {
    const p = writeRunManifest(path.join(dir, "run_3"), {
      runId: "run_3",
      inputVersions: {},
      referenceVersions: {},
      outputPaths: [],
      verifier: {
        name: "smoke",
        passed: false,
        exitCode: 5,
        detail: "401 for sk-ant-api03-FAKEFAKEFAKE",
      },
    });
    const raw = fs.readFileSync(p, "utf8");
    expect(raw).not.toContain("sk-ant-api03-FAKEFAKEFAKE");
    expect(raw).toContain("401 for");
  });
});
