import type { TerminalBackend } from "./types.js";
import { LocalBackend } from "./LocalBackend.js";
import { DockerBackend } from "./DockerBackend.js";
import { SSHBackend, E2BBackend } from "./SSHBackend.js";

export * from "./types.js";
export * from "./LocalBackend.js";
export * from "./DockerBackend.js";
export * from "./SSHBackend.js";

export function createTerminalBackend(type: "docker" | "ssh" | "e2b" | "local"): TerminalBackend {
  switch (type) {
    case "docker":
      return new DockerBackend();
    case "ssh":
      return new SSHBackend();
    case "e2b":
      return new E2BBackend();
    case "local":
    default:
      return new LocalBackend();
  }
}
