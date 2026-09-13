/**
 * One gate for every suite that needs a real Docker daemon AND the pinned sandbox image.
 *
 * Why both: the core-tests CI job runs on a runner with a live daemon but without
 * `trent-sandbox:<v>` built, and the tool suites there failed with "failed != completed" instead
 * of skipping (run 34766577226). The sandbox job builds the image first and asserts that nothing
 * skipped, so gating on the image keeps the no-skip proof exactly where it belongs.
 *
 * Resolved at collection time (top-level await) so `describe.skipIf` sees the answer.
 */
import { execFile } from "node:child_process";
import { SANDBOX_IMAGE } from "./sandbox-image.js";

function docker(args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile("docker", args, { timeout: 60_000 }, (error, stdout) => resolve(error ? "" : String(stdout ?? ""))),
  );
}

export interface DockerSandboxGate {
  readonly daemon: boolean;
  readonly image: boolean;
  readonly ready: boolean;
  /** Suffix for the describe title, empty when ready. */
  readonly skipNote: string;
}

export async function probeDockerSandbox(image: string = SANDBOX_IMAGE): Promise<DockerSandboxGate> {
  const daemon = (await docker(["version", "--format", "{{.Server.Version}}"])).trim().length > 0;
  const imagePresent = daemon && (await docker(["inspect", "--type", "image", "--format", "{{.Id}}", image])).trim().length > 0;
  const ready = daemon && imagePresent;
  const skipNote = ready ? "" : daemon ? ` [SKIPPED: ${image} not built; run trent sandbox build]` : " [SKIPPED: no Docker daemon]";
  return { daemon, image: imagePresent, ready, skipNote };
}
