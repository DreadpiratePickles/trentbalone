/**
 * `trent sandbox build`: builds the pinned sandbox image from `scripts/sandbox/Dockerfile` through
 * `docker build`, driven through `runCli` with a fake docker so no daemon is involved. `--json`
 * and `--dry-run` come from `defineCommand`. `--media` builds the media image the same way (X1).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@trent/core/errors/index.js";
import { SANDBOX_IMAGE, sandboxDockerfilePath } from "@trent/core/terminal/index.js";
import { MEDIA_IMAGE, mediaBuildArgs } from "@trent/core/tools/media/backend.js";
import { runCli } from "../index.js";
import type { CliOverrides } from "../context.js";
import { mediaDockerfilePath } from "../groups/sandbox.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-sandbox-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

type Call = { command: string; args: readonly string[] };

function fakeDocker(result: { code: number; stdout: string; stderr: string }): { calls: Call[]; overrides: CliOverrides } {
  const calls: Call[] = [];
  return {
    calls,
    overrides: {
      sandboxExec: async (command, args) => {
        calls.push({ command, args });
        return result;
      },
    },
  };
}

describe("trent sandbox build", () => {
  it("runs docker build with the pinned tag and the repo Dockerfile, and reports both", async () => {
    const docker = fakeDocker({ code: 0, stdout: "Successfully tagged", stderr: "" });
    const result = await runCli(["sandbox", "build", "--json"], { overrides: docker.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { image: string; dockerfile: string; built: boolean };
    expect(data.image).toBe(SANDBOX_IMAGE);
    expect(data.dockerfile).toBe(sandboxDockerfilePath());
    expect(data.built).toBe(true);
    // The build, then the size inspect the report carries.
    expect(docker.calls).toHaveLength(2);
    const [call, inspect] = docker.calls;
    expect(call?.command).toBe("docker");
    expect(call?.args.slice(0, 3)).toEqual(["build", "-t", SANDBOX_IMAGE]);
    expect(call?.args).toContain("-f");
    expect(call?.args).toContain(sandboxDockerfilePath());
    expect(inspect?.args).toEqual(["image", "inspect", "--format", "{{.Size}}", SANDBOX_IMAGE]);
  });

  it("--dry-run prints the command and calls nothing", async () => {
    const docker = fakeDocker({ code: 0, stdout: "", stderr: "" });
    const result = await runCli(["sandbox", "build", "--dry-run", "--json"], { overrides: docker.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { built: boolean; command: string[] };
    expect(data.built).toBe(false);
    expect(data.command.slice(0, 4)).toEqual(["docker", "build", "-t", SANDBOX_IMAGE]);
    expect(docker.calls).toHaveLength(0);
  });

  it("fails with docker's message when the daemon is down", async () => {
    const docker = fakeDocker({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" });
    const result = await runCli(["sandbox", "build", "--json"], { overrides: docker.overrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    // `--json` puts the error envelope on stdout, like every other command.
    const envelope = JSON.parse(result.stdout) as { error: { message: string; code: number } };
    expect(envelope.error.message).toMatch(/Cannot connect to the Docker daemon/);
    expect(envelope.error.code).toBe(EXIT.CONFIG);
    const human = await runCli(["sandbox", "build", "--no-color"], { overrides: docker.overrides });
    expect(human.exitCode).toBe(EXIT.CONFIG);
    expect(human.stderr).toMatch(/Cannot connect to the Docker daemon/);
  });

  it("renders the image name in human mode", async () => {
    const docker = fakeDocker({ code: 0, stdout: "", stderr: "" });
    const result = await runCli(["sandbox", "build", "--no-color"], { overrides: docker.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain(SANDBOX_IMAGE);
  });
});

/**
 * `--media` builds the media image (`trent-sandbox-media:<v>`, `scripts/sandbox/media/Dockerfile`)
 * with the argv `mediaBuildArgs` composes, then asks docker for the image's size, so the report
 * names both. Nothing is pulled from a registry: the argv has no `--pull`, and the fake sees no
 * `pull` call.
 */
describe("trent sandbox build --media", () => {
  function fakeMediaDocker(sizeBytes: string): { calls: Call[]; overrides: CliOverrides } {
    const calls: Call[] = [];
    return {
      calls,
      overrides: {
        sandboxExec: async (command, args) => {
          calls.push({ command, args });
          if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: `${sizeBytes}\n`, stderr: "" };
          return { code: 0, stdout: "Successfully tagged", stderr: "" };
        },
      },
    };
  }

  it("runs docker build with exactly mediaBuildArgs() and reports the image and its size", async () => {
    const docker = fakeMediaDocker("1740000000");
    const result = await runCli(["sandbox", "build", "--media", "--json"], { overrides: docker.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { image: string; dockerfile: string; built: boolean; sizeBytes: number | null; size: string | null; command: string[] };
    expect(data.image).toBe(MEDIA_IMAGE);
    expect(data.dockerfile).toBe(mediaDockerfilePath());
    expect(data.built).toBe(true);
    expect(data.sizeBytes).toBe(1_740_000_000);
    expect(data.size).toBe("1.74 GB");
    expect(docker.calls.map((call) => call.command)).toEqual(["docker", "docker"]);
    expect(docker.calls[0]?.args).toEqual(mediaBuildArgs({ dockerfile: mediaDockerfilePath() }));
    expect(docker.calls[0]?.args).not.toContain("--pull");
    expect(docker.calls[1]?.args).toEqual(["image", "inspect", "--format", "{{.Size}}", MEDIA_IMAGE]);
    expect(data.command).toEqual(["docker", ...mediaBuildArgs({ dockerfile: mediaDockerfilePath() })]);

    const human = await runCli(["sandbox", "build", "--media", "--no-color"], { overrides: docker.overrides });
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain(MEDIA_IMAGE);
    expect(human.stdout).toContain("1.74 GB");
  });

  it("--media --dry-run prints the media argv and calls nothing", async () => {
    const docker = fakeMediaDocker("1");
    const result = await runCli(["sandbox", "build", "--media", "--dry-run", "--json"], { overrides: docker.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { image: string; built: boolean; command: string[]; sizeBytes: number | null };
    expect(data.image).toBe(MEDIA_IMAGE);
    expect(data.built).toBe(false);
    expect(data.sizeBytes).toBeNull();
    expect(data.command).toEqual(["docker", ...mediaBuildArgs({ dockerfile: mediaDockerfilePath() })]);
    expect(docker.calls).toHaveLength(0);
  });

  it("honours TRENT_MEDIA_DOCKERFILE and --dockerfile for the media build", async () => {
    const docker = fakeMediaDocker("1");
    process.env.TRENT_MEDIA_DOCKERFILE = path.join(home, "Dockerfile.media");
    try {
      const viaEnv = await runCli(["sandbox", "build", "--media", "--dry-run", "--json"], { overrides: docker.overrides });
      expect((JSON.parse(viaEnv.stdout) as { dockerfile: string }).dockerfile).toBe(path.join(home, "Dockerfile.media"));
    } finally {
      delete process.env.TRENT_MEDIA_DOCKERFILE;
    }
    const explicit = path.join(home, "elsewhere", "Dockerfile");
    const viaFlag = await runCli(["sandbox", "build", "--media", "--dockerfile", explicit, "--dry-run", "--json"], { overrides: docker.overrides });
    const data = JSON.parse(viaFlag.stdout) as { dockerfile: string; command: string[] };
    expect(data.dockerfile).toBe(explicit);
    expect(data.command).toEqual(["docker", ...mediaBuildArgs({ dockerfile: explicit })]);
  });

  it("a build that fails names the media image and the daemon hint", async () => {
    const docker = fakeDocker({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" });
    const result = await runCli(["sandbox", "build", "--media", "--json"], { overrides: docker.overrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    const envelope = JSON.parse(result.stdout) as { error: { message: string; context?: { image?: string } } };
    expect(envelope.error.message).toMatch(/Cannot connect to the Docker daemon/);
    expect(envelope.error.message).toContain(MEDIA_IMAGE);
  });

  it("reports the base image without a size when docker's inspect does not answer with a number", async () => {
    const docker = fakeDocker({ code: 0, stdout: "Successfully tagged", stderr: "" });
    const result = await runCli(["sandbox", "build", "--json"], { overrides: docker.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { image: string; sizeBytes: number | null; size: string | null };
    expect(data.image).toBe(SANDBOX_IMAGE);
    expect(data.sizeBytes).toBeNull();
    expect(data.size).toBeNull();
  });
});
