import type { TerminalBackend } from "./types.js";
import { LocalBackend } from "./LocalBackend.js";
import { DockerBackend } from "./DockerBackend.js";

export * from "./types.js";
export * from "./LocalBackend.js";
export * from "./DockerBackend.js";
export * from "./sandbox-image.js";

export function createTerminalBackend(type: "docker" | "local"): TerminalBackend {
  return type === "docker" ? new DockerBackend() : new LocalBackend();
}
