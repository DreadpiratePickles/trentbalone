import { describe, expect, it } from "vitest";
import { runProcessWithTimeout } from "@/lib/process-watchdog";

describe("runProcessWithTimeout", () => {
  it("captures successful child process output", async () => {
    const result = await runProcessWithTimeout({
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: "ok\n",
    });
  });

  it("kills a child process that exceeds the timeout", async () => {
    const started = Date.now();
    const result = await runProcessWithTimeout({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50,
    });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("timed out");
  });

  it("streams stdout and stderr chunks while retaining final output", async () => {
    const chunks: string[] = [];
    const result = await runProcessWithTimeout({
      command: process.execPath,
      args: ["-e", "console.log('out-one'); console.error('err-one')"],
      timeoutMs: 1000,
      onStdout: (chunk) => chunks.push(`stdout:${chunk.trim()}`),
      onStderr: (chunk) => chunks.push(`stderr:${chunk.trim()}`),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("out-one");
    expect(result.stderr).toContain("err-one");
    expect(chunks).toEqual(expect.arrayContaining(["stdout:out-one", "stderr:err-one"]));
  });
});
