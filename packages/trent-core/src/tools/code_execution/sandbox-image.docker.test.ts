/**
 * The pinned sandbox image can actually run `execute_code`: the image is built from
 * `scripts/sandbox/Dockerfile` with the same `buildSandboxImage` the CLI command uses, and a
 * python and a javascript snippet each print a marker from inside the isolated container.
 * Skipped without a Docker daemon; `.github/workflows/sandbox.yml` runs it on a real one.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { probeDockerSandbox } from "../../terminal/docker-test-gate.js";
import { buildSandboxImage, SANDBOX_IMAGE } from "../../terminal/sandbox-image.js";
import { createCodeExecutionAdapter } from "./index.js";

function dockerCli(args: string[]): Promise<string> {
  return new Promise((resolve) => execFile("docker", args, { timeout: 60_000 }, (_e, stdout) => resolve(String(stdout ?? ""))));
}
// This suite BUILDS the image, so it needs only the daemon.
const gate = await probeDockerSandbox();
const dockerAvailable = gate.daemon;

describe.skipIf(!dockerAvailable)(`the pinned sandbox image on Docker${dockerAvailable ? "" : " [SKIPPED: no Docker daemon]"}`, () => {
  it(`builds ${SANDBOX_IMAGE} and runs execute_code in python and javascript as a non-root user with no network`, async () => {
    const built = await buildSandboxImage();
    expect(built.image).toBe(SANDBOX_IMAGE);
    expect((await dockerCli(["inspect", "--type", "image", "--format", "{{.Id}}", SANDBOX_IMAGE])).trim()).toMatch(/^sha256:/);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-sandbox-image-"));
    fs.mkdirSync(path.join(root, "profile"), { recursive: true });
    const adapter = createCodeExecutionAdapter({ workspace: root, profileDir: path.join(root, "profile"), backend: "docker", docker: { image: SANDBOX_IMAGE } });
    try {
      const marker = `marker-${Date.now().toString(36)}`;
      // The container user is the image's uid 1000 on macOS/Windows and the HOST uid on Linux
      // (DockerBackend passes --user so bind-mounted writes work under --cap-drop=ALL); on the
      // ubuntu runner that is 1001. The invariant is "never root", not a specific number.
      const hostUid = process.platform === "linux" && typeof process.getuid === "function" ? process.getuid() : 1000;
      const expectedUid = hostUid === 0 ? 1000 : hostUid;
      expect(expectedUid).not.toBe(0);
      const python = await adapter.execute(`execute_code ${JSON.stringify({ code: `import os, sys\nprint("py-${marker}", sys.version_info[0], os.getuid())` })}`, {});
      expect(python.status, python.summary).toBe("completed");
      expect(python.summary).toContain(`py-${marker} 3 ${expectedUid}`);

      const javascript = await adapter.execute(`execute_code ${JSON.stringify({ code: `console.log("js-${marker}", process.versions.node.split(".")[0], process.getuid())`, language: "javascript" })}`, {});
      expect(javascript.status, javascript.summary).toBe("completed");
      expect(javascript.summary).toMatch(new RegExp(`js-${marker} \\d+ ${expectedUid}`));

      // No package manager survives in the image, and the isolated container has no network.
      const apk = await adapter.execute('execute_code {"code":"import subprocess\\nprint(subprocess.run([\\"sh\\",\\"-c\\",\\"command -v apk || echo no-apk\\"],capture_output=True,text=True).stdout.strip())"}', {});
      expect(apk.summary).toContain("no-apk");
      const names = (adapter as { containerNames?: () => string[] }).containerNames?.() ?? [];
      expect(names.length).toBeGreaterThan(0);
      expect((await dockerCli(["inspect", "--format", "{{.HostConfig.NetworkMode}}", names[0]!])).trim()).toBe("none");
    } finally {
      await adapter.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
