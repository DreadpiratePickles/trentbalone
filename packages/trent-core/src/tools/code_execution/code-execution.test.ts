/**
 * `code_execution`: Hermes's `execute_code` over the seat's sandbox. Local backend here so the
 * suite runs everywhere; the sandbox contract (scrubbed env, workspace confinement) is the same
 * one `terminal` proves against Docker in `terminal.test.ts`.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { probeDockerSandbox } from "../../terminal/docker-test-gate.js";
import { spilloverDir, SUMMARY_LIMIT } from "../spillover.js";
import type { TrentToolAdapter } from "../types.js";
import { CODE_EXECUTION_NAME, CODE_EXECUTION_SCHEMAS, createCodeExecutionAdapter } from "./index.js";

const CANARY_NAME = "TRENT_CANARY_API_KEY";
const CANARY_VALUE = "canary-must-not-leak-9f3a";
/** Matches no allowlisted prefix and no secret substring: dropped by the allowlist alone. */
const PLAIN_NAME = "TRENT_CANARY_PLAIN";

function ps(): Promise<string> {
  return new Promise((resolve) => execFile("ps", ["-axo", "pid,command"], (_e, stdout) => resolve(String(stdout ?? ""))));
}

describe("code_execution on the local backend", () => {
  let root = "";
  let workspace = "";
  let profileDir = "";
  let adapter: TrentToolAdapter;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-code-"));
    workspace = path.join(root, "repo");
    profileDir = path.join(root, "profile");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    process.env[CANARY_NAME] = CANARY_VALUE;
    process.env[PLAIN_NAME] = CANARY_VALUE;
    adapter = createCodeExecutionAdapter({ workspace, profileDir, backend: "local" });
  });

  afterEach(() => {
    delete process.env[CANARY_NAME];
    delete process.env[PLAIN_NAME];
  });

  afterAll(async () => {
    await adapter.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("exposes Hermes's execute_code name and schema", () => {
    expect(adapter.name).toBe(CODE_EXECUTION_NAME);
    expect(adapter.scopes).toContain("execute_code");
    const schema = CODE_EXECUTION_SCHEMAS.find((s) => s.name === "execute_code");
    expect(schema?.parameters.required).toEqual(["code"]);
    expect(Object.keys(schema?.parameters.properties ?? {})).toEqual(expect.arrayContaining(["code", "language", "timeout"]));
    expect(adapter.instructions).toContain("execute_code");
  });

  it("a python snippet that prints a marker returns the marker", async () => {
    const rec = await adapter.execute('execute_code {"code":"print(\\"MARKER-\\" + str(6 * 7))"}', {});
    expect(rec.status, rec.summary).toBe("completed");
    expect(rec.summary).toContain("MARKER-42");
    expect(rec.adapter).toBe(CODE_EXECUTION_NAME);
  });

  it("a javascript snippet runs under node and captures stderr separately", async () => {
    const rec = await adapter.execute(
      `execute_code ${JSON.stringify({ language: "javascript", code: 'console.log("JS-MARKER"); console.error("to-stderr"); process.exitCode = 3;' })}`,
      {},
    );
    expect(rec.status).toBe("failed");
    expect(rec.summary).toContain("JS-MARKER");
    expect(rec.summary).toContain("[stderr]");
    expect(rec.summary).toContain("to-stderr");
    expect(rec.summary).toContain("exit code 3");
  });

  it("a snippet exceeding the timeout returns timed_out and leaves no process behind", async () => {
    const tag = `TRENT_TIMEOUT_TAG_${process.pid}_${Date.now()}`;
    const code = `import time\n_ = "${tag}"\nwhile True:\n    time.sleep(0.05)\n`;
    const started = Date.now();
    const rec = await adapter.execute(`execute_code ${JSON.stringify({ code, timeout: 1 })}`, {});
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(rec.status).toBe("failed");
    expect(rec.summary).toContain("timed_out");
    await new Promise((r) => setTimeout(r, 300));
    const alive = (await ps()).split("\n").filter((line) => line.includes(tag));
    expect(alive, alive.join("\n")).toEqual([]);
  });

  it("a snippet reading the environment sees no secret from the host", async () => {
    const py = await adapter.execute(
      `execute_code ${JSON.stringify({ code: `import os\nprint("KEY=" + repr(os.environ.get("${CANARY_NAME}")))\nprint("PLAIN=" + repr(os.environ.get("${PLAIN_NAME}")))\nprint("PATH_OK=" + str(bool(os.environ.get("PATH"))))` })}`,
      {},
    );
    expect(py.status, py.summary).toBe("completed");
    expect(py.summary).toContain("KEY=None");
    expect(py.summary).toContain("PLAIN=None");
    expect(py.summary).toContain("PATH_OK=True");
    expect(py.summary).not.toContain(CANARY_VALUE);

    const js = await adapter.execute(
      `execute_code ${JSON.stringify({ language: "javascript", code: `console.log("KEY=" + String(process.env.${CANARY_NAME})); console.log("PLAIN=" + String(process.env.${PLAIN_NAME}));` })}`,
      {},
    );
    expect(js.status, js.summary).toBe("completed");
    expect(js.summary).toContain("KEY=undefined");
    expect(js.summary).toContain("PLAIN=undefined");
    expect(js.summary).not.toContain(CANARY_VALUE);
  });

  it("output over the summary limit spills to a file and keeps a head/tail window", async () => {
    const rec = await adapter.execute(`execute_code ${JSON.stringify({ code: 'print("x" * 30000)' })}`, {});
    expect(rec.status, rec.summary).toBe("completed");
    expect(rec.summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(rec.summary).toContain("characters omitted");
    const spilled = fs.readdirSync(spilloverDir(profileDir)).filter((f) => f.startsWith("execute_code"));
    expect(spilled.length).toBeGreaterThan(0);
  });

  it("applies the terminal approval floor: hardline code is blocked, dangerous code needs approval", async () => {
    const hardline = 'import os\nos.system("rm -rf /")';
    const rec = await adapter.execute(`execute_code ${JSON.stringify({ code: hardline })}`, {});
    expect(rec.status).toBe("blocked");
    expect(adapter.requiresApproval(`execute_code ${JSON.stringify({ code: hardline })}`)).toBe(false);
    const dangerous = 'import subprocess\nsubprocess.run("git push --force origin main", shell=True)';
    expect(adapter.requiresApproval(`execute_code ${JSON.stringify({ code: dangerous })}`)).toBe(true);
    expect(adapter.requiresApproval('execute_code {"code":"print(1)"}')).toBe(false);
  });

  it("rejects an unknown language and a missing code argument with usage, never running anything", async () => {
    const bad = await adapter.execute('execute_code {"code":"print(1)","language":"ruby"}', {});
    expect(bad.status).toBe("failed");
    expect(bad.summary).toMatch(/python|javascript/);
    const missing = await adapter.execute('execute_code {"command":"ls"}', {});
    expect(missing.status).toBe("failed");
    expect(missing.summary).toContain("code");
  });
});

function dockerCli(args: string[]): Promise<string> {
  return new Promise((resolve) => execFile("docker", args, { timeout: 60_000 }, (_e, stdout) => resolve(String(stdout ?? ""))));
}
const gate = await probeDockerSandbox();
const dockerAvailable = gate.ready;

describe.skipIf(!dockerAvailable)(`code_execution on Docker${gate.skipNote}`, () => {
  it("runs in the isolated container (NetworkMode=none) and reports a missing interpreter honestly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-code-docker-"));
    fs.mkdirSync(path.join(root, "profile"), { recursive: true });
    const adapter = createCodeExecutionAdapter({ workspace: root, profileDir: path.join(root, "profile"), backend: "docker", docker: { image: "alpine:3" } });
    try {
      const rec = await adapter.execute('execute_code {"code":"print(1)"}', {});
      const names = (adapter as TrentToolAdapter & { containerNames?: () => string[] }).containerNames?.() ?? [];
      expect(rec.status).toBe("failed");
      expect(rec.summary).toMatch(/python3 is not available in this sandbox/);
      if (names.length) {
        const mode = await dockerCli(["inspect", "--format", "{{.HostConfig.NetworkMode}}", names[0]!]);
        expect(mode.trim()).toBe("none");
      }
    } finally {
      await adapter.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

