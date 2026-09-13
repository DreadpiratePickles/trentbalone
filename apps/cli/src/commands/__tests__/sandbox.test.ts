/**
 * `trent sandbox build`: builds the pinned sandbox image from `scripts/sandbox/Dockerfile` through
 * `docker build`, driven through `runCli` with a fake docker so no daemon is involved. `--json`
 * and `--dry-run` come from `defineCommand`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@trent/core/errors/index.js";
import { SANDBOX_IMAGE, sandboxDockerfilePath } from "@trent/core/terminal/index.js";
import { runCli } from "../index.js";
import type { CliOverrides } from "../context.js";

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
    expect(docker.calls).toHaveLength(1);
    const [call] = docker.calls;
    expect(call?.command).toBe("docker");
    expect(call?.args.slice(0, 3)).toEqual(["build", "-t", SANDBOX_IMAGE]);
    expect(call?.args).toContain("-f");
    expect(call?.args).toContain(sandboxDockerfilePath());
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
