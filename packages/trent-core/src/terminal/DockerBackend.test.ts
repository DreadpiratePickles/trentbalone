/**
 * The old backend interpolated the command, the cwd and every env value into a shell string passed
 * to `exec`. These tests pin the replacement: argument arrays only, isolation flags always, and a
 * clean skip when no Docker daemon is present rather than a false PASS.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DockerBackend, buildCreateArgs, buildExecArgs } from "./DockerBackend.js";

const NASTY_CWD = '/tmp/pwn"; touch /tmp/trent-escaped; echo "';
const NASTY_ENV_VALUE = '$(touch /tmp/trent-env-escaped)`whoami`';

// Resolved at COLLECTION time via top-level await. A `beforeAll` would run after `describe.skipIf`
// has already been evaluated, which would silently skip the live suite even where Docker exists.
const dockerAvailable = await new DockerBackend().isAvailable();
const liveSuiteTitle = dockerAvailable
  ? "DockerBackend live daemon lifecycle"
  : "DockerBackend live daemon lifecycle [SKIPPED: no Docker daemon - untested-on-this-platform]";

describe("DockerBackend argument construction", () => {
  it("never interpolates the command into a shell string", () => {
    const args = buildExecArgs("ctr", 'echo "hi" && rm -rf /', {});
    expect(args[0]).toBe("exec");
    // The command survives as exactly one argv element, so the shell inside the container -
    // and never the host shell - is the only thing that sees it.
    expect(args).toContain('echo "hi" && rm -rf /');
    expect(args.filter((a) => a === 'echo "hi" && rm -rf /')).toHaveLength(1);
    for (const arg of args) {
      expect(arg).not.toMatch(/^docker /);
    }
  });

  it("passes a working directory containing shell metacharacters as one opaque argument", () => {
    const args = buildExecArgs("ctr", "pwd", { cwd: NASTY_CWD });
    const wIndex = args.indexOf("-w");
    expect(wIndex).toBeGreaterThan(-1);
    expect(args[wIndex + 1]).toBe(NASTY_CWD);
    // No element smuggles the metacharacters into a larger string.
    expect(args.some((a) => a !== NASTY_CWD && a.includes("touch /tmp/trent-escaped"))).toBe(false);
  });

  it("passes environment values as KEY=VALUE argv elements, unquoted and unescaped", () => {
    const args = buildExecArgs("ctr", "env", { env: { EVIL: NASTY_ENV_VALUE } });
    expect(args).toContain(`EVIL=${NASTY_ENV_VALUE}`);
    const eIndex = args.indexOf(`EVIL=${NASTY_ENV_VALUE}`);
    expect(args[eIndex - 1]).toBe("-e");
  });

  it("applies network and privilege isolation flags on create", () => {
    const args = buildCreateArgs({
      containerName: "trent-sandbox-test",
      image: "node:22-alpine",
      network: "none",
    });
    expect(args[0]).toBe("create");
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--name");
    expect(args[args.length - 1]).not.toBe("");
  });

  it("mounts the egress CA read-only and points the runtimes at it", () => {
    const caPath = path.join(os.tmpdir(), "trent-ca.crt");
    const args = buildCreateArgs({
      containerName: "trent-sandbox-ca",
      image: "node:22-alpine",
      caCertPath: caPath,
      proxyUrl: "http://127.0.0.1:8089",
      proxyToken: "trnt_egress_" + "a".repeat(32),
      credentialEnvNames: ["OPENAI_API_KEY"],
    });
    const mount = args[args.indexOf("-v") + 1]!;
    expect(mount).toBe(`${caPath}:/usr/local/share/ca-certificates/trent-egress-ca.crt:ro`);
    expect(args).toContain("NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/trent-egress-ca.crt");
    expect(args).toContain("HTTPS_PROXY=http://127.0.0.1:8089");
    expect(args).toContain(`OPENAI_API_KEY=trnt_egress_${"a".repeat(32)}`);
  });

  it("mounts a volume whose host path contains metacharacters as one argument", () => {
    const args = buildCreateArgs({
      containerName: "trent-sandbox-vol",
      image: "node:22-alpine",
      volumes: [{ hostPath: NASTY_CWD, containerPath: "/workspace", readOnly: false }],
    });
    expect(args).toContain(`${NASTY_CWD}:/workspace`);
  });
});

describe("DockerBackend without a daemon", () => {
  it("reports unavailable and returns a non-zero result instead of throwing", async () => {
    if (dockerAvailable) return;
    const backend = new DockerBackend();
    const res = await backend.execute("echo hi");
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("Docker");
  });
});

describe.skipIf(!dockerAvailable)(liveSuiteTitle, () => {
  it("creates, execs and removes a container", async () => {
    const backend = new DockerBackend({ image: "alpine:3", network: "none" });
    const id = await backend.create();
    expect(id).toMatch(/^[0-9a-f]{12,}$/);
    await backend.start();
    const res = await backend.exec("echo trent-live-docker");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("trent-live-docker");
    await backend.cleanup();
    expect(await backend.containerExists()).toBe(false);
  }, 120000);

  it("does not let shell metacharacters in the cwd escape into the host", async () => {
    const marker = path.join(os.tmpdir(), "trent-escaped");
    fs.rmSync(marker, { force: true });
    const backend = new DockerBackend({ image: "alpine:3", network: "none" });
    await backend.execute("pwd", { cwd: NASTY_CWD }).catch(() => undefined);
    await backend.cleanup();
    expect(fs.existsSync(marker)).toBe(false);
  }, 120000);
});
