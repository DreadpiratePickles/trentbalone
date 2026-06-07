import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type HyperFramesAction =
  | "create"
  | "catalog"
  | "preview"
  | "lint"
  | "inspect"
  | "render";

export type HyperFramesConfig = {
  executionEnabled: boolean;
  workspaceRoot: string;
};

export type HyperFramesPayload = {
  projectName?: string;
  projectPath?: string;
  template?: string;
  component?: string;
  output?: string;
  quality?: "draft" | "standard" | "high";
  fps?: number;
  format?: "mp4" | "webm";
  port?: number;
  json?: boolean;
  tailwind?: boolean;
};

export function buildHyperFramesToolScopes() {
  return [
    "hyperframes:create",
    "hyperframes:catalog",
    "hyperframes:preview",
    "hyperframes:lint",
    "hyperframes:inspect",
    "hyperframes:render",
  ];
}

export function getHyperFramesConfig(env: Partial<NodeJS.ProcessEnv> = process.env): HyperFramesConfig {
  return {
    executionEnabled: env.HYPERFRAMES_EXECUTION === "enabled",
    workspaceRoot: env.HYPERFRAMES_WORKSPACE_ROOT ?? process.cwd(),
  };
}

export function buildHyperFramesCommandPlan(action: HyperFramesAction, payload: HyperFramesPayload = {}) {
  const args = ["hyperframes"];

  if (action === "create") {
    args.push("init", payload.projectName ?? "growth-video");
    if (payload.template) args.push("--example", payload.template);
    if (payload.tailwind) args.push("--tailwind");
    args.push("--non-interactive");
  } else if (action === "catalog") {
    args.push("add", payload.component ?? "product-promo");
  } else if (action === "preview") {
    args.push("preview");
    if (payload.port) args.push("--port", String(payload.port));
  } else if (action === "lint") {
    args.push("lint");
    if (payload.projectPath) args.push(payload.projectPath);
    if (payload.json) args.push("--json");
  } else if (action === "inspect") {
    args.push("inspect");
    if (payload.projectPath) args.push(payload.projectPath);
    if (payload.json) args.push("--json");
  } else if (action === "render") {
    args.push("render");
    if (payload.output) args.push("--output", payload.output);
    if (payload.quality) args.push("--quality", payload.quality);
    if (payload.fps) args.push("--fps", String(payload.fps));
    if (payload.format) args.push("--format", payload.format);
  }

  return ["npx", ...args];
}

export function formatHyperFramesCommand(command: string[]) {
  return command.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
}

export function resolveHyperFramesCwd(config: HyperFramesConfig, payload: HyperFramesPayload) {
  const root = path.resolve(config.workspaceRoot);
  const requested = path.resolve(root, payload.projectPath ?? ".");
  if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
    throw new Error("HyperFrames projectPath must stay inside HYPERFRAMES_WORKSPACE_ROOT.");
  }
  return requested;
}

export async function executeHyperFramesCommand(
  action: HyperFramesAction,
  payload: HyperFramesPayload = {},
  config: HyperFramesConfig = getHyperFramesConfig(),
) {
  const [command, ...args] = buildHyperFramesCommandPlan(action, payload);
  const cwd = resolveHyperFramesCwd(config, payload);
  const result = await execFileAsync(command, args, {
    cwd,
    timeout: 10 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  });
  return {
    command: formatHyperFramesCommand([command, ...args]),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
