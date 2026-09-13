/**
 * `trent sandbox`: the Docker image the seats' tools run inside.
 *
 * `build` runs `docker build` on `scripts/sandbox/Dockerfile` with the pinned tag from
 * `@trent/core/terminal` (`trent-sandbox:<version>`), the same reference `DockerBackend` defaults
 * to and `trent doctor` probes. Nothing is pulled from a registry: the image is not published.
 * `--dry-run` prints the exact argv and calls nothing; `--json` comes from `defineCommand`.
 */

import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { buildSandboxImage, execDocker, SANDBOX_IMAGE, sandboxBuildArgs, sandboxDockerfilePath } from "@trent/core/terminal/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

export interface SandboxBuildData extends Record<string, unknown> {
  image: string;
  dockerfile: string;
  built: boolean;
  command: string[];
}

function renderBuild(data: SandboxBuildData, ctx: CommandContext): string[] {
  const label = data.built ? ctx.theme.success("built") : ctx.theme.meta("would build");
  return [
    `  ${label} ${ctx.theme.value(data.image)}`,
    `  ${ctx.theme.meta("from")} ${data.dockerfile}`,
    ...(data.built ? [] : [`  ${ctx.theme.meta("command")} ${data.command.join(" ")}`]),
  ];
}

export const sandboxSpec: CommandSpec = {
  name: "sandbox",
  description: "The Docker sandbox image the seats' tools run inside",
  subcommands: [
    {
      name: "build",
      description: `Build ${SANDBOX_IMAGE} from scripts/sandbox/Dockerfile (python3 + node, no package manager, non-root)`,
      options: [{ flags: "--dockerfile <path>", description: "Build from this Dockerfile instead of the repository's" }],
      async run(ctx, opts) {
        const dockerfile = typeof opts.dockerfile === "string" && opts.dockerfile !== "" ? opts.dockerfile : sandboxDockerfilePath();
        const command = ["docker", ...sandboxBuildArgs({ dockerfile })];
        if (ctx.dryRun) return { data: { image: SANDBOX_IMAGE, dockerfile, built: false, command } satisfies SandboxBuildData };
        try {
          const built = await buildSandboxImage({ dockerfile, exec: ctx.overrides.sandboxExec ?? execDocker });
          return { data: { image: built.image, dockerfile: built.dockerfile, built: true, command } satisfies SandboxBuildData };
        } catch (error) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "sandbox build",
            message: `${error instanceof Error ? error.message : String(error)}. Start Docker Desktop (or the docker daemon) and run it again; \`trent doctor\` shows the daemon state`,
            context: { dockerfile, image: SANDBOX_IMAGE },
          });
        }
      },
      render: (data, ctx) => renderBuild(data as SandboxBuildData, ctx),
    },
  ],
};
