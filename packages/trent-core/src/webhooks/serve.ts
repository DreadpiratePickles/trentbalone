/**
 * [H3] The one call a surface makes to serve `gateway.webhooks.routes`: build the engine over the
 * surface's runner port, mount it on the gateway's `WebhookServer`, and listen where the block
 * says. No routes, nothing is built and nothing listens.
 */
import type { WebhooksConfig } from "../config/sections/gateway.js";
import type { GatewayManager } from "../gateway/GatewayManager.js";
import { WebhookServer } from "../gateway/WebhookServer.js";
import { createWebhookEngine, type WebhookEngineDeps } from "./engine.js";
import { webhookHttpHandler } from "./http.js";
import type { WebhookRunnerFor } from "./types.js";

export interface OpenWebhookRoutesInput {
  readonly block: WebhooksConfig | undefined;
  readonly profileDir: string;
  /** The chat adapters' `/webhooks/<platform>` paths are served from the same listener. */
  readonly manager: GatewayManager;
  readonly runnerFor: WebhookRunnerFor;
  readonly seedInbound?: WebhookEngineDeps["seedInbound"];
  readonly secret?: WebhookEngineDeps["secret"];
  readonly log?: (line: string) => void;
}

export interface OpenedWebhookRoutes {
  readonly host: string;
  readonly port: number;
  readonly routes: readonly string[];
  /** Aborts the runs still going, stops listening, and waits for their end rows. */
  close(): Promise<void>;
}

export async function openWebhookRoutes(input: OpenWebhookRoutesInput): Promise<OpenedWebhookRoutes | undefined> {
  const block = input.block;
  if (block === undefined || block.routes.length === 0) return undefined;
  const engine = createWebhookEngine({
    routes: block.routes,
    profileDir: input.profileDir,
    runnerFor: input.runnerFor,
    ...(input.seedInbound === undefined ? {} : { seedInbound: input.seedInbound }),
    ...(input.secret === undefined ? {} : { secret: input.secret }),
    ...(input.log === undefined ? {} : { log: input.log }),
  });
  const server = new WebhookServer(input.manager, { routes: webhookHttpHandler(engine) });
  const port = await server.listen(block.port, block.host);
  let closed = false;
  return {
    host: block.host,
    port,
    routes: block.routes.map((route) => route.name),
    async close() {
      if (closed) return;
      closed = true;
      engine.close();
      await server.close();
      await engine.idle();
    },
  };
}
