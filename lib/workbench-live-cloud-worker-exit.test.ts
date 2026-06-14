import { describe, expect, it, vi } from "vitest";
import { runProcessWithTimeout } from "@/lib/process-watchdog";
import {
  disconnectWorkerDatabases,
  resolveWatchdogParentExitCode,
  shouldEmitWatchdogTimeoutFailure,
} from "@/lib/workbench-live-cloud-worker-exit";

describe("resolveWatchdogParentExitCode", () => {
  it("returns child exit code when the watchdog did not time out", () => {
    expect(resolveWatchdogParentExitCode({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      durationMs: 10,
    })).toBe(0);
  });

  it("returns 1 when the watchdog timed out", () => {
    expect(resolveWatchdogParentExitCode({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout: '{"passed":true}',
      stderr: "",
      durationMs: 900_000,
    })).toBe(1);
  });
});

describe("shouldEmitWatchdogTimeoutFailure", () => {
  it("emits timeout failure only when timedOut is true", () => {
    expect(shouldEmitWatchdogTimeoutFailure({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      durationMs: 10,
    })).toBe(false);
    expect(shouldEmitWatchdogTimeoutFailure({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout: "",
      stderr: "Process timed out",
      durationMs: 50,
    })).toBe(true);
  });
});

describe("disconnectWorkerDatabases", () => {
  it("no-ops when DATABASE_URL is unset", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    await expect(disconnectWorkerDatabases()).resolves.toBeUndefined();
    if (previous) process.env.DATABASE_URL = previous;
  });
});

describe("live cloud worker exit via watchdog", () => {
  it("exits promptly when the worker calls process.exit(0)", async () => {
    const started = Date.now();
    const result = await runProcessWithTimeout({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 5_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("times out and exits nonzero when the child keeps the event loop alive", async () => {
    const started = Date.now();
    const result = await runProcessWithTimeout({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(resolveWatchdogParentExitCode(result)).toBe(1);
    expect(shouldEmitWatchdogTimeoutFailure(result)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("exitWorker", () => {
  it("calls process.exit with the requested code", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    const { exitWorker } = await import("@/lib/workbench-live-cloud-worker-exit");
    await expect(exitWorker(0)).rejects.toThrow("exit:0");
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});
