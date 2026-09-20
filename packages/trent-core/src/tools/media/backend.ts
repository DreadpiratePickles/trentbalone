/**
 * Where a media tool runs (B2, review item 9). Two backends behind one interface:
 *
 *   host    `execFile(<binary>, [args])` with `shell: false` and a scrubbed environment. The
 *           binary is resolved on PATH by this module, and only a name in {@link MEDIA_BINARIES}
 *           is ever resolved: there is no way to hand this backend an arbitrary program.
 *   docker  `docker run --rm --network none --cap-drop=ALL ... trent-sandbox-media:<v> <binary>
 *           [args]` with the workspace bind-mounted at /workspace. Chosen when the image exists
 *           (`docker inspect --type image`), the same probe the doctor and the test gate use.
 *
 * Every argument array is built by `commands.ts` from validated values and paths RELATIVE to the
 * workspace, and both backends run with the workspace as the working directory, so the argv a
 * tool builds is the argv that runs, on either backend. Nothing here ever composes a shell string.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveContainerUser } from "../../terminal/DockerBackend.js";
import { scrubChildEnv } from "../../terminal/env-scrub.js";

/** Bump when `scripts/sandbox/media/Dockerfile` changes; the doctor then reports the old build as absent. */
export const MEDIA_IMAGE_VERSION = "1";
export const MEDIA_IMAGE_REPOSITORY = "trent-sandbox-media";
export const MEDIA_IMAGE = `${MEDIA_IMAGE_REPOSITORY}:${MEDIA_IMAGE_VERSION}`;
/** Relative to the repository root. */
export const MEDIA_DOCKERFILE = path.join("scripts", "sandbox", "media", "Dockerfile");
/** Where a whisper model directory is mounted inside the media container. */
export const MEDIA_MODELS_MOUNT = "/trent/models";
export const WORKSPACE_MOUNT = "/workspace";

/**
 * The only programs a media tool may run. `whisper-cli` is whisper.cpp's executable (Homebrew's
 * `whisper-cpp` formula and the upstream build both install it under that name); `python3` is
 * run only with a script this module ships as a constant, for faster-whisper and MediaPipe.
 */
export const MEDIA_BINARIES = ["ffmpeg", "ffprobe", "whisper-cli", "scenedetect", "python3"] as const;
export type MediaBinary = (typeof MEDIA_BINARIES)[number];

export interface MediaExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MediaRunOptions {
  readonly timeoutMs?: number;
  /** Host directories the docker backend mounts read-only (a whisper model directory). */
  readonly readOnlyMounts?: ReadonlyArray<{ readonly host: string; readonly container: string }>;
}

export interface MediaBackend {
  readonly kind: "host" | "docker";
  /** Runs one allowlisted binary with an argument array, in the workspace. Throws for a name outside the allowlist. */
  run(binary: MediaBinary, args: readonly string[], options?: MediaRunOptions): Promise<MediaExecResult>;
  /** Which allowlisted binaries this backend can run right now. */
  installed(): Promise<Readonly<Record<MediaBinary, boolean>>>;
  /** The path a host model file has inside this backend's process (the mount path on docker). */
  modelRef(hostModelPath: string): { readonly arg: string; readonly mounts: MediaRunOptions["readOnlyMounts"] };
}

export interface MediaBackendOptions {
  /** Absolute host path of the workspace; every relative argument resolves against it. */
  readonly workspace: string;
  /** The environment the PATH lookup and the child process see; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam for the docker CLI; defaults to `execFile("docker", ...)` over the same env. */
  readonly exec?: MediaExec;
}

export type MediaExec = (command: string, args: readonly string[], options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<MediaExecResult>;

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;

export function isMediaBinary(name: string): name is MediaBinary {
  return (MEDIA_BINARIES as readonly string[]).includes(name);
}

/** `which`, over the env's PATH only: an executable regular file, never a directory. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (name.includes("/") || name.includes("\\")) return undefined;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** `execFile` with an argument array: no shell, ever. Rejects only when the child cannot be spawned. */
export const execMedia: MediaExec = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: MAX_BUFFER, shell: false }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(error);
        return;
      }
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error.killed ? 124 : 1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

function assertAllowlisted(binary: string): asserts binary is MediaBinary {
  if (!isMediaBinary(binary)) throw new Error(`"${binary}" is not on the media binary allowlist (${MEDIA_BINARIES.join(", ")}); it was not run`);
}

export function createHostMediaBackend(options: MediaBackendOptions): MediaBackend {
  const env = options.env ?? process.env;
  const exec = options.exec ?? execMedia;
  const childEnv = { ...scrubChildEnv(env), PATH: env.PATH ?? "" };
  return {
    kind: "host",
    async run(binary, args, runOptions) {
      assertAllowlisted(binary);
      const resolved = findOnPath(binary, env);
      if (resolved === undefined) return { code: 127, stdout: "", stderr: `${binary} is not installed on this machine (not found on PATH)` };
      return exec(resolved, args, { cwd: options.workspace, timeoutMs: runOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS, env: childEnv });
    },
    async installed() {
      return Object.fromEntries(MEDIA_BINARIES.map((name) => [name, findOnPath(name, env) !== undefined])) as Record<MediaBinary, boolean>;
    },
    modelRef: (hostModelPath) => ({ arg: hostModelPath, mounts: [] }),
  };
}

/** The `docker run` argv for one media command: hardened exactly as the terminal sandbox is. */
export function dockerRunArgs(input: {
  readonly workspace: string;
  readonly image: string;
  readonly binary: MediaBinary;
  readonly args: readonly string[];
  readonly readOnlyMounts?: MediaRunOptions["readOnlyMounts"];
  readonly user?: string;
}): string[] {
  const argv = ["run", "--rm", "--network", "none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit", "256"];
  argv.push("-v", `${input.workspace}:${WORKSPACE_MOUNT}`, "-w", WORKSPACE_MOUNT);
  for (const mount of input.readOnlyMounts ?? []) argv.push("-v", `${mount.host}:${mount.container}:ro`);
  if (input.user) argv.push("--user", input.user, "-e", "HOME=/tmp");
  argv.push(input.image, input.binary, ...input.args);
  return argv;
}

export function createDockerMediaBackend(options: MediaBackendOptions & { readonly image?: string }): MediaBackend {
  const env = options.env ?? process.env;
  const exec = options.exec ?? execMedia;
  const image = options.image ?? MEDIA_IMAGE;
  const docker = findOnPath("docker", env) ?? "docker";
  const user = resolveContainerUser({ platform: process.platform, uid: process.getuid?.(), gid: process.getgid?.() });
  return {
    kind: "docker",
    async run(binary, args, runOptions) {
      assertAllowlisted(binary);
      const argv = dockerRunArgs({ workspace: options.workspace, image, binary, args, readOnlyMounts: runOptions?.readOnlyMounts, ...(user ? { user } : {}) });
      return exec(docker, argv, { cwd: options.workspace, timeoutMs: runOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS, env: { ...scrubChildEnv(env), PATH: env.PATH ?? "" } });
    },
    async installed() {
      // The image is built with every binary on the list; `installed` answers for the image, not the host.
      return Object.fromEntries(MEDIA_BINARIES.map((name) => [name, true])) as Record<MediaBinary, boolean>;
    },
    modelRef: (hostModelPath) => ({
      arg: `${MEDIA_MODELS_MOUNT}/${path.basename(hostModelPath)}`,
      mounts: [{ host: path.dirname(hostModelPath), container: MEDIA_MODELS_MOUNT }],
    }),
  };
}

/** `docker inspect --type image` exits 0 with an id when the image is present; the form the 29.x daemon answers. */
export async function mediaImagePresent(env: NodeJS.ProcessEnv = process.env, exec: MediaExec = execMedia, image: string = MEDIA_IMAGE): Promise<boolean> {
  const docker = findOnPath("docker", env);
  if (docker === undefined) return false;
  try {
    const result = await exec(docker, ["inspect", "--type", "image", "--format", "{{.Id}}", image], { cwd: process.cwd(), timeoutMs: 15_000, env: { ...scrubChildEnv(env), PATH: env.PATH ?? "" } });
    return result.code === 0 && result.stdout.trim() !== "";
  } catch {
    return false;
  }
}

export interface SelectMediaBackendInput extends MediaBackendOptions {
  /** `media.backend` from config; `auto` prefers docker when the image exists. */
  readonly backend?: "auto" | "host" | "docker";
}

/** Docker when the media image exists (or is forced), the host's own binaries otherwise. */
export async function selectMediaBackend(input: SelectMediaBackendInput): Promise<MediaBackend> {
  const preference = input.backend ?? "auto";
  if (preference === "host") return createHostMediaBackend(input);
  const present = await mediaImagePresent(input.env ?? process.env, input.exec ?? execMedia);
  if (preference === "docker" || present) return createDockerMediaBackend(input);
  return createHostMediaBackend(input);
}

/** What is installed for the doctor and quick setup: the host's binaries, and whether the image exists. */
export interface MediaInstallReport {
  readonly host: Readonly<Record<MediaBinary, boolean>>;
  readonly image: boolean;
  /** `docker` when the image exists, `host` when ffmpeg and ffprobe are on PATH, `none` otherwise. */
  readonly backend: "docker" | "host" | "none";
}

export async function reportMediaInstall(env: NodeJS.ProcessEnv = process.env, exec: MediaExec = execMedia): Promise<MediaInstallReport> {
  const host = await createHostMediaBackend({ workspace: process.cwd(), env, exec }).installed();
  const image = await mediaImagePresent(env, exec);
  return { host, image, backend: image ? "docker" : host.ffmpeg && host.ffprobe ? "host" : "none" };
}

/** `docker build -t <tag> -f <Dockerfile> <its directory>`: an argv, never a shell string; no `--pull` (see `terminal/sandbox-image.ts`). */
export function mediaBuildArgs(input: { dockerfile: string; tag?: string }): string[] {
  return ["build", "-t", input.tag ?? MEDIA_IMAGE, "-f", input.dockerfile, path.dirname(input.dockerfile)];
}

/** The one-line build command the doctor and docs name, relative to the repository root. */
export function mediaBuildCommand(): string {
  return `docker build -f ${MEDIA_DOCKERFILE.split(path.sep).join("/")} -t ${MEDIA_IMAGE} ${path.dirname(MEDIA_DOCKERFILE).split(path.sep).join("/")}`;
}

/** Quick setup's question: is there any backend at all? */
export async function mediaBackendPresent(env: NodeJS.ProcessEnv = process.env, exec: MediaExec = execMedia): Promise<boolean> {
  return (await reportMediaInstall(env, exec)).backend !== "none";
}
