/**
 * The three checks that used to return hard-coded green from inside a try block that could not
 * throw. Each test induces a real failure and asserts it is reported.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import { checkMcp } from "./mcp.js";
import { checkCron } from "./cron.js";
import { checkWorkbench } from "./workbench.js";
import { SANDBOX_IMAGE } from "../../terminal/sandbox-image.js";
import type { DoctorContext } from "../types.js";
import { runCommand } from "../probe.js";

let tempDir: string;
let configManager: ConfigManager;

const context = (over: Partial<DoctorContext> = {}): DoctorContext => ({
  baseDir: tempDir,
  profile: "default",
  configManager,
  probeTimeoutMs: 200,
  ...over,
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-inspect-"));
  configManager = new ConfigManager({ baseDir: tempDir });
  configManager.ensureDirs();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeMcpServers(servers: unknown): void {
  fs.writeFileSync(
    path.join(configManager.getProfileDir(), "mcp.json"),
    JSON.stringify({ servers }, null, 2),
  );
}

describe("mcp check", () => {
  it("fails and names the server when it is unreachable", async () => {
    writeMcpServers({ "acme-crm": { url: "https://mcp.invalid.example/sse" } });
    const result = await checkMcp.run(
      context({
        fetchImpl: async () => {
          throw new TypeError("fetch failed: ENOTFOUND mcp.invalid.example");
        },
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toContain("acme-crm");
    expect(result.fixHint).toBeTruthy();
  });

  it("fails and names a stdio server whose command is not installed", async () => {
    writeMcpServers({ "local-tool": { command: "trent-no-such-binary-xyz" } });
    const result = await checkMcp.run(context());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("local-tool");
  });

  it("reports skip when no MCP servers are configured, never a hard-coded green", async () => {
    const result = await checkMcp.run(context());
    expect(result.status).toBe("skip");
    expect(result.message).not.toContain("marketplace");
  });

  it("passes only after a server actually answers", async () => {
    writeMcpServers({ "acme-crm": { url: "https://mcp.example.test/sse" } });
    const result = await checkMcp.run(
      context({ fetchImpl: async () => new Response("", { status: 200 }) }),
    );
    expect(result.status).toBe("ok");
    expect(result.details?.reachable).toEqual(["acme-crm"]);
  });
});

describe("cron check", () => {
  it("warns with a reason when no scheduler state exists", async () => {
    const result = await checkCron.run(context());
    expect(result.status).toBe("warn");
    expect(result.message.toLowerCase()).toContain("no scheduler state");
    expect(result.fixHint).toBeTruthy();
  });

  it("fails when the scheduler state file is unparseable", async () => {
    fs.writeFileSync(path.join(configManager.getProfileDir(), "cron.json"), "{not json");
    const result = await checkCron.run(context());
    expect(result.status).toBe("fail");
    expect(result.fixHint).toBeTruthy();
  });

  it("warns and names a job whose next run is long overdue", async () => {
    const overdue = new Date(Date.now() - 48 * 3600_000).toISOString();
    fs.writeFileSync(
      path.join(configManager.getProfileDir(), "cron.json"),
      JSON.stringify({ jobs: [{ id: "nightly-digest", schedule: "0 3 * * *", next_run: overdue }] }),
    );
    const result = await checkCron.run(context());
    expect(result.status).toBe("warn");
    expect(result.message).toContain("nightly-digest");
  });

  it("passes only when real jobs are scheduled and on time", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    fs.writeFileSync(
      path.join(configManager.getProfileDir(), "cron.json"),
      JSON.stringify({ jobs: [{ id: "nightly-digest", schedule: "0 3 * * *", next_run: future }] }),
    );
    const result = await checkCron.run(context());
    expect(result.status).toBe("ok");
    expect(result.details?.jobs).toBe(1);
  });
});

describe("workbench check", () => {
  it("fails naming Docker when the daemon is not running", async () => {
    const result = await checkWorkbench.run(
      context({
        execImpl: async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }),
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/Docker/);
    expect(result.fixHint).toBeTruthy();
  });

  it("fails naming Docker when the docker binary is absent", async () => {
    const result = await checkWorkbench.run(
      context({
        execImpl: async () => {
          throw new Error("spawn docker ENOENT");
        },
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/Docker/);
  });

  it("a real probe reports what this machine's daemon reports: not ok when it is down, ok only with the image present", async () => {
    // An independent probe with the same commands, so the expected status is measured, not assumed.
    const daemon = await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], 5000).catch(() => undefined);
    const up = daemon !== undefined && daemon.code === 0 && daemon.stdout.trim() !== "";
    const image = configManager.loadConfig().terminal.docker.image;
    const present = up && (await runCommand("docker", ["inspect", "--type", "image", "--format", "{{.Id}}", image], 5000).catch(() => undefined))?.code === 0;
    const result = await checkWorkbench.run(context());
    expect(result.message).toMatch(/Docker/i);
    expect(result.status).toBe(!up ? "fail" : present ? "ok" : "warn");
  }, 20000);

  it("warns that the local backend has no isolation", async () => {
    configManager.saveConfig({
      ...configManager.loadConfig(),
      terminal: { ...configManager.loadConfig().terminal, backend: "local" },
    });
    const result = await checkWorkbench.run(context());
    expect(result.status).toBe("warn");
    expect(result.message.toLowerCase()).toContain("isolation");
  });

  it("passes only when the daemon actually answers", async () => {
    const result = await checkWorkbench.run(
      context({ execImpl: async () => ({ code: 0, stdout: "Server Version: 27.0.3", stderr: "" }) }),
    );
    expect(result.status).toBe("ok");
  });

  /**
   * A docker shim that behaves like the 29.x daemon on this machine: `docker image inspect <ref>`
   * says "No such image" for an image it lists and runs; only `docker inspect --type image <ref>`
   * answers. The check must use the form that works. No daemon is involved.
   */
  function dockerShim(present: readonly string[]) {
    const calls: string[][] = [];
    const execImpl: DoctorContext["execImpl"] = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd !== "docker") return { code: 127, stdout: "", stderr: `${cmd}: not found` };
      if (args[0] === "info") return { code: 0, stdout: "29.1.0\n", stderr: "" };
      if (args[0] === "inspect" && args[1] === "--type" && args[2] === "image") {
        const ref = args[args.length - 1] ?? "";
        return present.includes(ref)
          ? { code: 0, stdout: "sha256:0123456789abcdef\n", stderr: "" }
          : { code: 1, stdout: "", stderr: `Error: No such image: ${ref}` };
      }
      return { code: 1, stdout: "", stderr: `Error: No such image: ${args[args.length - 1] ?? ""}` };
    };
    return { execImpl, calls };
  }

  it("reports the configured image present when only `docker inspect --type image` knows it", async () => {
    const image = "trent-sandbox:latest";
    configManager.saveConfig({
      ...configManager.loadConfig(),
      terminal: { ...configManager.loadConfig().terminal, backend: "docker", docker: { ...configManager.loadConfig().terminal.docker, image } },
    });
    const shim = dockerShim([image]);
    const result = await checkWorkbench.run(context({ execImpl: shim.execImpl }));
    expect(result.status).toBe("ok");
    expect(result.message).not.toMatch(/not present/);
    expect(result.details).toMatchObject({ image, serverVersion: "29.1.0" });
    expect(shim.calls.some((call) => call[1] === "inspect" && call[2] === "--type" && call[3] === "image")).toBe(true);
    expect(shim.calls.some((call) => call[1] === "image" && call[2] === "inspect")).toBe(false);
  });

  it("with the default config it probes the pinned trent-sandbox image: warn naming `trent sandbox build` when absent", async () => {
    const shim = dockerShim([]);
    const result = await checkWorkbench.run(context({ execImpl: shim.execImpl }));
    expect(result.status).toBe("warn");
    expect(result.message).toContain(SANDBOX_IMAGE);
    expect(result.message).toMatch(/execute_code/);
    expect(result.fixHint).toContain("trent sandbox build");
    expect(result.details).toMatchObject({ image: SANDBOX_IMAGE, sandboxImage: SANDBOX_IMAGE });
    expect(shim.calls.some((call) => call[1] === "inspect" && call[call.length - 1] === SANDBOX_IMAGE)).toBe(true);
  });

  it("with the default config it reports ok when the pinned trent-sandbox image is present", async () => {
    const shim = dockerShim([SANDBOX_IMAGE]);
    const result = await checkWorkbench.run(context({ execImpl: shim.execImpl }));
    expect(result.status).toBe("ok");
    expect(result.message).toContain(SANDBOX_IMAGE);
    expect(result.details).toMatchObject({ image: SANDBOX_IMAGE });
  });

  it("warns, naming the image, when the daemon runs but the image is absent", async () => {
    const image = "trent-sandbox:latest";
    configManager.saveConfig({
      ...configManager.loadConfig(),
      terminal: { ...configManager.loadConfig().terminal, backend: "docker", docker: { ...configManager.loadConfig().terminal.docker, image } },
    });
    const shim = dockerShim([]);
    const result = await checkWorkbench.run(context({ execImpl: shim.execImpl }));
    expect(result.status).toBe("warn");
    expect(result.message).toContain(image);
    expect(result.fixHint).toContain(image);
  });
});
