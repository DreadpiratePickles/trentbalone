import fs from "node:fs";
import type { CheckResult, DoctorCheck, DoctorContext, ExecResult } from "../types.js";
import { DEFAULT_PROBE_TIMEOUT_MS, runCommand } from "../probe.js";
import { isTrentSandboxImage, SANDBOX_IMAGE } from "../../terminal/sandbox-image.js";

/**
 * This check used to report the configured backend as if configuring it made it work. A backend
 * named in a YAML file is a claim; `docker info` exiting 0 is evidence.
 *
 * [G12] When Docker does not answer, the runtime does not stop: the REPL and `trent run` fall back
 * to the local backend (`apps/cli/src/repl/tools.ts` `resolveSandbox`, used by both), and no config
 * key turns that fallback off (`config/sections/terminal.ts`). So the doctor agrees with the
 * runtime: a warning that names the fallback and its lack of isolation, not a failure.
 */

/** What the REPL and `trent run` print when they fall back (`resolveSandbox`). */
const FALLBACK =
  "the REPL and `trent run` fall back to the local backend, so commands run on this machine, confined to the workspace, with no container isolation";

const CATEGORY = "Workbench";
const NAME = "Sandbox & Workbench";

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

async function dockerInfo(ctx: DoctorContext, timeoutMs: number): Promise<ExecResult | Error> {
  const exec = ctx.execImpl ?? runCommand;
  try {
    return await exec("docker", ["info", "--format", "{{.ServerVersion}}"], timeoutMs);
  } catch (err) {
    return err as Error;
  }
}

export const checkWorkbench: DoctorCheck = {
  id: "check_workbench",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const config = ctx.configManager.loadConfig();
    const backend = config.terminal?.backend ?? "docker";
    const timeoutMs = ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

    if (backend === "local") {
      return result({
        status: "warn",
        message: "Sandbox backend is \"local\": commands run directly on this machine with no isolation.",
        fixHint: "Set `terminal.backend` to docker and start Docker Desktop for an isolated sandbox.",
        details: { backend },
      });
    }

    const info = await dockerInfo(ctx, timeoutMs);

    const explicit = "or set `terminal.backend` to local to make the fallback explicit";
    if (info instanceof Error) {
      return result({
        status: "warn",
        message: `Docker is the configured sandbox backend but the docker binary could not be run on this machine; ${FALLBACK}.`,
        fixHint: `Install Docker Desktop for an isolated sandbox, ${explicit}.`,
        details: { backend, reason: "binary-missing", fallback: "local" },
      });
    }

    if (info.code === 124) {
      return result({
        status: "warn",
        message: `Docker did not answer within ${timeoutMs}ms (the daemon is unresponsive); ${FALLBACK}.`,
        fixHint: `Restart Docker Desktop, then re-run \`trent doctor\`; ${explicit}.`,
        details: { backend, reason: "timeout", fallback: "local" },
      });
    }

    if (info.code !== 0) {
      return result({
        status: "warn",
        message: `Docker is installed but the Docker daemon is not running; ${FALLBACK}.`,
        fixHint: `Start Docker Desktop for an isolated sandbox, then re-run \`trent doctor\`; ${explicit}.`,
        details: { backend, exitCode: info.code, reason: "daemon-down", fallback: "local" },
      });
    }

    // The configured image defaults to the pinned build of scripts/sandbox/Dockerfile; the check
    // asks for THAT exact reference, so an older trent-sandbox build reads as absent.
    const image = config.terminal?.docker?.image ?? SANDBOX_IMAGE;
    const serverVersion = info.stdout.trim();
    const imageMissing = await imageAbsent(ctx, image, timeoutMs);
    const details = { backend, serverVersion, image, sandboxImage: SANDBOX_IMAGE };

    if (imageMissing) {
      const ours = isTrentSandboxImage(image);
      return result({
        status: "warn",
        message: ours
          ? `Docker daemon is running (server ${serverVersion}) but the sandbox image ${image} is not present locally, so execute_code has no python3 or node until it is built.`
          : `Docker daemon is running (server ${serverVersion}) but the sandbox image ${image} is not present locally.`,
        fixHint: ours ? `Run \`trent sandbox build\` to build ${image} from scripts/sandbox/Dockerfile.` : `Build or pull the image: \`docker pull ${image}\`.`,
        details,
      });
    }

    return result({
      status: "ok",
      message: `Docker daemon answered${serverVersion ? ` (server ${serverVersion})` : ""}; the sandbox image ${image} is present and the sandbox can start.`,
      details,
    });
  },
};

/**
 * `docker inspect --type image <ref>` is the form that answers on the 29.x daemon; the
 * `docker image inspect <ref>` form reports "No such image" for images the daemon lists and
 * runs, so it is not used (the REPL's `probeDockerCli` uses the same form). Goes through the
 * injected exec like the daemon probe, so a shim can prove the form without a daemon.
 */
async function imageAbsent(ctx: DoctorContext, image: string, timeoutMs: number): Promise<boolean> {
  const exec = ctx.execImpl ?? runCommand;
  try {
    const out = await exec("docker", ["inspect", "--type", "image", "--format", "{{.Id}}", image], timeoutMs);
    return out.code !== 0 || out.stdout.trim() === "";
  } catch {
    return false;
  }
}

/** Exported for the setup wizard: does this machine have a usable sandbox at all? */
export function localBackendAvailable(): boolean {
  return fs.existsSync("/bin/sh");
}
