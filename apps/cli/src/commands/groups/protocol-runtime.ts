/**
 * The agent runtime the protocol servers (`trent a2a serve`, `trent acp`) run on.
 *
 * Both are advertised surfaces, so a task submitted to either must become a REAL orchestration
 * run — the same object graph the REPL and the messaging gateway run on, with no terminal
 * (AGENTS.md invariant 2). `@trent/core` cannot import the CLI, so the runtime crosses the
 * boundary as the `AgentRunner` port the servers take, and a server built without one refuses
 * honestly instead of composing an answer.
 *
 * It lives beside `servers.ts` rather than inside it only to keep that file under 500 lines.
 */

import type { AgentRunner } from "@trent/core/a2a/index.js";
import type { CommandContext } from "../context.js";
import type { ReplConfig } from "../../repl/types.js";
import { createHeadlessRuntime } from "../../runtime/headless.js";

export interface ProtocolRuntime {
  readonly runner: AgentRunner;
  /** Gives back the proxy and the sandboxes. Every exit path calls it. */
  readonly release: () => Promise<void>;
}

/**
 * `overrides.gatewayRuntime` is the one headless-runtime seam a test replaces; it is reused here
 * rather than duplicated, so a protocol-server test needs no proxy, sandbox or model either.
 */
export async function openProtocolRuntime(ctx: CommandContext): Promise<ProtocolRuntime> {
  const configManager = ctx.config();
  const config = configManager.loadConfig();
  const runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({
    configManager,
    config: config as unknown as ReplConfig,
  });
  return {
    runner: {
      run: ({ objective, signal }) => runtime.run(objective, signal === undefined ? {} : { signal }),
    },
    release: () => runtime.cleanup(),
  };
}
