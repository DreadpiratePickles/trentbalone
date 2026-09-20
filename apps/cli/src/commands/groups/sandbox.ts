/**
 * `trent sandbox`: the Docker images the seats' tools run inside.
 *
 * `build` runs `docker build` on `scripts/sandbox/Dockerfile` with the pinned tag from
 * `@trent/core/terminal` (`trent-sandbox:<version>`), the same reference `DockerBackend` defaults
 * to and `trent doctor` probes. `build --media` builds the media image instead
 * (`scripts/sandbox/media/Dockerfile`, `trent-sandbox-media:<version>` from `tools/media/backend.ts`),
 * the container the `media_*` tools prefer when it exists and the doctor's Media Pipeline line
 * points at when it is absent. Nothing is pulled from a registry: neither image is published.
 * After a build the report carries the size docker reports for the image. `--dry-run` prints the
 * exact argv and calls nothing; `--json` comes from `defineCommand`.
 */

import path from "node:path";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import {
  execDocker, formatImageSize, imageSizeBytes, repoRootFromSource, SANDBOX_IMAGE, sandboxBuildArgs, sandboxDockerfilePath, type SandboxExec,
} from "@trent/core/terminal/index.js";
import { MEDIA_DOCKERFILE, MEDIA_IMAGE, mediaBuildArgs } from "@trent/core/tools/media/backend.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

export interface SandboxBuildData extends Record<string, unknown> {
  image: string;
  dockerfile: string;
  built: boolean;
  command: string[];
  /** Bytes docker reports for the built image; null before a build or when docker gave no number. */
  sizeBytes: number | null;
  /** `sizeBytes` as docker prints it (`1.74 GB`); null when `sizeBytes` is. */
  size: string | null;
}

/** `TRENT_MEDIA_DOCKERFILE` wins (the compiled binary has no source tree); otherwise the repo's file. */
export function mediaDockerfilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TRENT_MEDIA_DOCKERFILE;
  if (override !== undefined && override.trim() !== "") return path.resolve(override);
  return path.join(repoRootFromSource(), MEDIA_DOCKERFILE);
}

interface BuildTarget {
  readonly image: string;
  readonly dockerfile: string;
  readonly args: string[];
}

/** Which image the flags name, and the argv that builds it: the base by default, the media image under `--media`. */
function buildTarget(opts: Record<string, unknown>): BuildTarget {
  const explicit = typeof opts.dockerfile === "string" && opts.dockerfile !== "" ? opts.dockerfile : undefined;
  if (opts.media === true) {
    const dockerfile = explicit ?? mediaDockerfilePath();
    return { image: MEDIA_IMAGE, dockerfile, args: mediaBuildArgs({ dockerfile }) };
  }
  const dockerfile = explicit ?? sandboxDockerfilePath();
  return { image: SANDBOX_IMAGE, dockerfile, args: sandboxBuildArgs({ dockerfile }) };
}

/** Runs the build argv, then asks docker for the image's size. Throws with docker's own stderr when the build fails. */
async function runBuild(target: BuildTarget, exec: SandboxExec): Promise<{ sizeBytes: number | null }> {
  const result = await exec("docker", target.args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `docker build exited ${result.code}`;
    throw new Error(`docker build of ${target.image} failed: ${detail.split("\n").slice(-5).join("\n")}`);
  }
  return { sizeBytes: await imageSizeBytes(exec, target.image) };
}

function renderBuild(data: SandboxBuildData, ctx: CommandContext): string[] {
  const label = data.built ? ctx.theme.success("built") : ctx.theme.meta("would build");
  const size = data.size === null ? "" : ` ${ctx.theme.meta(`(${data.size})`)}`;
  return [
    `  ${label} ${ctx.theme.value(data.image)}${size}`,
    `  ${ctx.theme.meta("from")} ${data.dockerfile}`,
    ...(data.built ? [] : [`  ${ctx.theme.meta("command")} ${data.command.join(" ")}`]),
  ];
}

export const sandboxSpec: CommandSpec = {
  name: "sandbox",
  description: "The Docker sandbox images the seats' tools run inside",
  subcommands: [
    {
      name: "build",
      description: `Build ${SANDBOX_IMAGE} from scripts/sandbox/Dockerfile (python3 + node, no package manager, non-root); --media builds ${MEDIA_IMAGE} instead`,
      options: [
        { flags: "--dockerfile <path>", description: "Build from this Dockerfile instead of the repository's" },
        { flags: "--media", description: `Build the media image ${MEDIA_IMAGE} (ffmpeg, whisper.cpp with a base model, scenedetect, mediapipe) from scripts/sandbox/media/Dockerfile` },
      ],
      async run(ctx, opts) {
        const target = buildTarget(opts);
        const command = ["docker", ...target.args];
        const base = { image: target.image, dockerfile: target.dockerfile, command };
        if (ctx.dryRun) return { data: { ...base, built: false, sizeBytes: null, size: null } satisfies SandboxBuildData };
        try {
          const { sizeBytes } = await runBuild(target, ctx.overrides.sandboxExec ?? execDocker);
          return { data: { ...base, built: true, sizeBytes, size: sizeBytes === null ? null : formatImageSize(sizeBytes) } satisfies SandboxBuildData };
        } catch (error) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "sandbox build",
            message: `${error instanceof Error ? error.message : String(error)}. Start Docker Desktop (or the docker daemon) and run it again; \`trent doctor\` shows the daemon state`,
            context: { dockerfile: target.dockerfile, image: target.image },
          });
        }
      },
      render: (data, ctx) => renderBuild(data as SandboxBuildData, ctx),
    },
  ],
};
