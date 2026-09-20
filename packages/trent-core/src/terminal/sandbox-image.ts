/**
 * The pinned sandbox image, named in exactly one place.
 *
 * `execute_code` needs python3 and node inside the container; a bare alpine reports both as "not
 * available in this sandbox". The image is built locally from `scripts/sandbox/Dockerfile` (it is
 * not published anywhere) as `trent-sandbox:<version>` — never `latest`, so the doctor can say
 * whether THIS build is present and a Dockerfile change is a version bump, not a silent drift.
 * `DockerBackend`, the config default, the tool builder and the doctor all read the name from here.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Bump when `scripts/sandbox/Dockerfile` changes; the doctor then reports the old build as absent. */
export const SANDBOX_IMAGE_VERSION = "1";
export const SANDBOX_IMAGE_REPOSITORY = "trent-sandbox";
export const SANDBOX_IMAGE = `${SANDBOX_IMAGE_REPOSITORY}:${SANDBOX_IMAGE_VERSION}`;

/** Relative to the repository root. */
export const SANDBOX_DOCKERFILE = path.join("scripts", "sandbox", "Dockerfile");

export type SandboxExecResult = { code: number; stdout: string; stderr: string };
/** The same shape as the doctor's `ExecLike`, minus its timeout: a build is allowed to take minutes. */
export type SandboxExec = (command: string, args: readonly string[]) => Promise<SandboxExecResult>;

const BUILD_TIMEOUT_MS = 10 * 60_000;

/**
 * The repository root when running from source: this file is `packages/trent-core/src/terminal/`.
 * Exported for the other image built from this tree (`scripts/sandbox/media/Dockerfile`, whose
 * relative path lives in `tools/media/backend.ts`), so both builds resolve the root one way.
 */
export function repoRootFromSource(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * `docker image inspect --format {{.Size}} <image>` after a build: the bytes docker reports, or
 * null when docker did not answer with a number (an old daemon, a fake in a test). A build is
 * reported either way; the size is information, never a gate.
 */
export async function imageSizeBytes(exec: SandboxExec, image: string): Promise<number | null> {
  const result = await exec("docker", ["image", "inspect", "--format", "{{.Size}}", image]);
  if (result.code !== 0) return null;
  const bytes = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

/** `1.74 GB`, `812 MB`, `3 KB`: two decimals from a gigabyte up, whole units below, powers of ten as docker prints them. */
export function formatImageSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** `TRENT_SANDBOX_DOCKERFILE` wins (the compiled binary has no source tree); otherwise the repo's file. */
export function sandboxDockerfilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TRENT_SANDBOX_DOCKERFILE;
  if (override !== undefined && override.trim() !== "") return path.resolve(override);
  return path.join(repoRootFromSource(), SANDBOX_DOCKERFILE);
}

/** Is this reference one of ours, i.e. a tag the `trent sandbox build` command can produce? */
export function isTrentSandboxImage(image: string): boolean {
  return image === SANDBOX_IMAGE_REPOSITORY || image.startsWith(`${SANDBOX_IMAGE_REPOSITORY}:`);
}

/**
 * `docker build -t <tag> -f <Dockerfile> <its directory>`: an argv, never a shell string. No
 * `--pull`: the base is pinned to a minor tag in the Dockerfile, and BuildKit's registry
 * metadata lookup hit its deadline behind Docker Desktop's proxy on the dev machine (measured
 * 2026-09-13: `docker pull alpine:3.20` took minutes, the build itself 3s once the base was local).
 */
export function sandboxBuildArgs(input: { dockerfile: string; tag?: string }): string[] {
  return ["build", "-t", input.tag ?? SANDBOX_IMAGE, "-f", input.dockerfile, path.dirname(input.dockerfile)];
}

/** The real exec: `execFile`, argument array, no shell, a build-sized timeout. */
export const execDocker: SandboxExec = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { timeout: BUILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, shell: false }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export interface BuildSandboxImageInput {
  readonly exec?: SandboxExec;
  readonly dockerfile?: string;
  readonly tag?: string;
}

export interface BuiltSandboxImage {
  readonly image: string;
  readonly dockerfile: string;
}

/** Builds the pinned image. Throws with docker's own stderr when the build fails. */
export async function buildSandboxImage(input: BuildSandboxImageInput = {}): Promise<BuiltSandboxImage> {
  const dockerfile = input.dockerfile ?? sandboxDockerfilePath();
  const image = input.tag ?? SANDBOX_IMAGE;
  const result = await (input.exec ?? execDocker)("docker", sandboxBuildArgs({ dockerfile, tag: image }));
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `docker build exited ${result.code}`;
    throw new Error(`docker build of ${image} failed: ${detail.split("\n").slice(-5).join("\n")}`);
  }
  return { image, dockerfile };
}
