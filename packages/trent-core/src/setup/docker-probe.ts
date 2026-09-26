/**
 * [L2] Does the Docker daemon answer? `docker info` exiting 0 is the evidence the doctor uses
 * (`doctor/checks/workbench.ts`); setup asks the same question without importing `doctor/`.
 *
 * `setup --mode local` writes `terminal.backend: local` when it does not: a machine running its models
 * locally is often a laptop without Docker Desktop, and the REPL and `trent run` already fall back to
 * the local backend then (docs/terminal.md). The binary is found on the PATH of `env`, so a test that
 * points PATH at an empty directory gets "absent" without a daemon.
 */
import { execFile } from "node:child_process";

export const DOCKER_PROBE_TIMEOUT_MS = 8_000;

export function dockerAnswers(env: NodeJS.ProcessEnv, timeoutMs: number = DOCKER_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    // Any failure (no binary, daemon down, a timeout) means Docker cannot run the sandbox now.
    execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { env, timeout: timeoutMs, windowsHide: true }, (error) => resolve(error === null));
  });
}
