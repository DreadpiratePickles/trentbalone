/**
 * The pinned sandbox image: one name every surface agrees on, a Dockerfile that can run
 * `execute_code`, and a build that is `docker build` with that tag and that file — proven with a
 * fake exec so no daemon is needed here. The gated Docker suite in `tools/code_execution/` builds
 * the real image and runs both interpreters.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { DockerBackend } from "./DockerBackend.js";
import {
  buildSandboxImage,
  formatImageSize,
  imageSizeBytes,
  SANDBOX_IMAGE,
  SANDBOX_IMAGE_VERSION,
  sandboxBuildArgs,
  sandboxDockerfilePath,
  type SandboxExec,
} from "./sandbox-image.js";

describe("the pinned sandbox image", () => {
  it("is trent-sandbox tagged with a version, never latest, and is DockerBackend's default", () => {
    expect(SANDBOX_IMAGE).toBe(`trent-sandbox:${SANDBOX_IMAGE_VERSION}`);
    expect(SANDBOX_IMAGE_VERSION).toMatch(/^\d+$/);
    expect(new DockerBackend().getImage()).toBe(SANDBOX_IMAGE);
  });

  it("has a Dockerfile in scripts/sandbox that pins alpine, installs python3 and nodejs, drops root and removes apk", () => {
    const file = sandboxDockerfilePath();
    expect(file.endsWith("scripts/sandbox/Dockerfile")).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(/^FROM alpine:3\.\d+$/m);
    expect(text).toMatch(/apk add --no-cache[^\n]*\bpython3\b/);
    expect(text).toMatch(/apk add --no-cache[^\n]*\bnodejs\b/);
    const instructions = text.split("\n").filter((line) => line !== "" && !line.startsWith("#")).join("\n");
    expect(instructions).not.toMatch(/\bnpm\b|py3-pip/);
    expect(text).toMatch(/rm -f \/sbin\/apk/);
    expect(text).toMatch(/^USER sandbox$/m);
    expect(text).toMatch(/^WORKDIR \/workspace$/m);
  });

  it("builds with `docker build -t <pinned tag> -f <Dockerfile> <its directory>`", () => {
    const args = sandboxBuildArgs({ dockerfile: "/repo/scripts/sandbox/Dockerfile" });
    expect(args).toEqual(["build", "-t", SANDBOX_IMAGE, "-f", "/repo/scripts/sandbox/Dockerfile", "/repo/scripts/sandbox"]);
  });

  it("buildSandboxImage runs exactly that command and reports the tag, or fails with docker's stderr", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const ok: SandboxExec = async (command, args) => {
      calls.push([command, args]);
      return { code: 0, stdout: "Successfully tagged", stderr: "" };
    };
    const built = await buildSandboxImage({ exec: ok, dockerfile: "/repo/scripts/sandbox/Dockerfile" });
    expect(built).toEqual({ image: SANDBOX_IMAGE, dockerfile: "/repo/scripts/sandbox/Dockerfile" });
    expect(calls).toEqual([["docker", sandboxBuildArgs({ dockerfile: "/repo/scripts/sandbox/Dockerfile" })]]);

    const down: SandboxExec = async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" });
    await expect(buildSandboxImage({ exec: down, dockerfile: "/repo/scripts/sandbox/Dockerfile" })).rejects.toThrow(/Cannot connect to the Docker daemon/);
  });

  it("imageSizeBytes reads docker's {{.Size}} and gives null for anything that is not a number; formatImageSize prints it as docker does", async () => {
    const seen: Array<readonly string[]> = [];
    const answers = async (_command: string, args: readonly string[]) => {
      seen.push(args);
      return { code: 0, stdout: "1740000000\n", stderr: "" };
    };
    expect(await imageSizeBytes(answers, "trent-sandbox-media:1")).toBe(1_740_000_000);
    expect(seen).toEqual([["image", "inspect", "--format", "{{.Size}}", "trent-sandbox-media:1"]]);
    expect(await imageSizeBytes(async () => ({ code: 1, stdout: "", stderr: "No such image" }), "x")).toBeNull();
    expect(await imageSizeBytes(async () => ({ code: 0, stdout: "Successfully tagged", stderr: "" }), "x")).toBeNull();
    expect(formatImageSize(1_740_000_000)).toBe("1.74 GB");
    expect(formatImageSize(812_000_000)).toBe("812 MB");
    expect(formatImageSize(3_200)).toBe("3 KB");
    expect(formatImageSize(12)).toBe("12 B");
  });
});
