/**
 * The agent runtime the protocol servers (`trent a2a serve`, `trent acp`) run on.
 *
 * Both are advertised surfaces, so a task submitted to either must become a REAL orchestration
 * run — the same object graph the REPL and the messaging gateway run on, with no terminal
 * (AGENTS.md invariant 2). `@trent/core` cannot import the CLI, so the runtime crosses the
 * boundary as the `AgentRunner` port the servers take, and a server built without one refuses
 * honestly instead of composing an answer.
 *
 * It lives beside `servers.ts` rather than inside it only to keep that file under 500 lines, and
 * for the same reason it carries the two helpers every long-running command shares: the port
 * parser and the "listening" renderer. `servers.ts` and `protocol-commands.ts` both read them from
 * here, so neither file has to import the other.
 */

import type { AgentRunner } from "@trent/core/a2a/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { CommandContext } from "../context.js";
import type { ReplConfig } from "../../repl/types.js";
import { createHeadlessRuntime } from "../../runtime/headless.js";

/** Which protocol server opened it. It is the surface its runs are charged to (G3.1). */
export type ProtocolSurface = "a2a" | "acp";

export interface ProtocolRuntime {
  readonly runner: AgentRunner;
  /** Gives back the proxy and the sandboxes. Every exit path calls it. */
  readonly release: () => Promise<void>;
}

/**
 * `overrides.gatewayRuntime` is the one headless-runtime seam a test replaces; it is reused here
 * rather than duplicated, so a protocol-server test needs no proxy, sandbox or model either.
 */
export async function openProtocolRuntime(ctx: CommandContext, surface: ProtocolSurface): Promise<ProtocolRuntime> {
  const configManager = ctx.config();
  const config = configManager.loadConfig();
  const runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({
    configManager,
    config: config as unknown as ReplConfig,
    // [G3.1] The two protocol servers share this function and not a cap: each names itself, so a
    // task delegated over A2A and a prompt from an editor over ACP are told apart on the ledger.
    surface,
  });
  return {
    runner: {
      run: ({ objective, signal }) => runtime.run(objective, signal === undefined ? {} : { signal }),
    },
    release: () => runtime.cleanup(),
  };
}

export const A2A_DEFAULT_PORT = "7895";
export const ACP_DEFAULT_PORT = "7890";
export const WEB_DEFAULT_PORT = "3000";

export function parsePort(value: unknown, operation: string, fallback: string): number {
  const port = Number(typeof value === "string" && value !== "" ? value : fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TrentError({
      code: EXIT.USAGE,
      operation,
      message: "port must be an integer between 1 and 65535",
      target: String(value),
    });
  }
  return port;
}

export function listeningRender(kind: string) {
  return (data: Record<string, unknown> | unknown[], ctx: CommandContext): string[] => {
    const d = data as { port?: number; listening?: boolean; dryRun?: boolean };
    if (d.dryRun === true) {
      return [`  ${ctx.theme.meta(`would start ${kind} on port`)} ${ctx.theme.value(String(d.port))}`];
    }
    return [
      `  ${ctx.theme.success(`${kind} listening`)} ${ctx.theme.value(`http://127.0.0.1:${String(d.port)}`)}`,
      `  ${ctx.theme.meta("Ctrl+C to stop")}`,
    ];
  };
}
