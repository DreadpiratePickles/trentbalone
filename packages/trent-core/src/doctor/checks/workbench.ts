import fs from "node:fs";
import type { CheckResult, DoctorCheck, DoctorContext, ExecResult } from "../types.js";
import { DEFAULT_PROBE_TIMEOUT_MS, runCommand } from "../probe.js";
import { isTrentSandboxImage, SANDBOX_IMAGE } from "../../terminal/sandbox-image.js";

/**
 * This check used to report the configured backend as if configuring it made it work. A backend
 * named in a YAML file is a claim; `docker info` exiting 0 is evidence. On this machine the Docker
 * daemon is not running, so the honest answer today is a failure that names Docker.
 */

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

    if (backend === "ssh") {
      const host = config.terminal?.ssh?.host;
      if (!host) {
        return result({
          status: "fail",
          message: "Sandbox backend is \"ssh\" but no host is configured, so no sandbox can be opened.",
          fixHint: "Run `trent config set terminal.ssh.host <hostname>`.",
          details: { backend },
        });
      }
      return result({
        status: "warn",
        message: `Sandbox backend is "ssh" targeting ${host}; the doctor does not open an SSH session to verify it.`,
        fixHint: "Verify with `ssh <host> true` before relying on the sandbox.",
        details: { backend, host },
      });
    }

    if (backend === "e2b") {
      const hasKey = Boolean(process.env.E2B_API_KEY);
      return hasKey
        ? result({
            status: "warn",
            message: "Sandbox backend is \"e2b\"; a key is present but no sandbox was started to verify it.",
            fixHint: "Start one sandbox from the web app's workbench to confirm E2B accepts the key; the CLI has no sandbox command.",
            details: { backend },
          })
        : result({
            status: "fail",
            message: "Sandbox backend is \"e2b\" but E2B_API_KEY is not set, so no sandbox can start.",
            fixHint: "Run `trent config set E2B_API_KEY <your-api-key>`.",
            details: { backend },
          });
    }

    const info = await dockerInfo(ctx, timeoutMs);

    if (info instanceof Error) {
      return result({
        status: "fail",
        message: "Docker is the configured sandbox backend but the docker binary could not be run on this machine.",
        fixHint: "Install Docker Desktop, or set `terminal.backend` to local (which gives no isolation).",
        details: { backend, reason: "binary-missing" },
      });
    }

    if (info.code === 124) {
      return result({
        status: "fail",
        message: `Docker did not answer within ${timeoutMs}ms; the daemon is unresponsive.`,
        fixHint: "Restart Docker Desktop, then re-run `trent doctor`.",
        details: { backend, reason: "timeout" },
      });
    }

    if (info.code !== 0) {
      return result({
        status: "fail",
        message: "Docker is installed but the Docker daemon is not running, so the sandbox cannot start.",
        fixHint: "Start Docker Desktop, then re-run `trent doctor`.",
        details: { backend, exitCode: info.code, reason: "daemon-down" },
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
