/**
 * [H3] What `trent gateway status` shows for webhook routes: the routes configured, where the
 * listener binds when the gateway runs, and the last deliveries from the store (read-only).
 */
import type { WebhooksConfig } from "../config/sections/gateway.js";
import { readDeliveries } from "./store.js";
import type { DeliveryRow } from "./types.js";

export const STATUS_DELIVERIES = 5;

export interface WebhookStatusView {
  readonly listen?: string;
  readonly routes: ReadonlyArray<{ readonly name: string; readonly path: string; readonly signature: string; readonly mode: string }>;
  readonly last: readonly DeliveryRow[];
}

export function webhookStatus(profileDir: string, block: WebhooksConfig | undefined, limit = STATUS_DELIVERIES): WebhookStatusView {
  const routes = (block?.routes ?? []).map((route) => ({ name: route.name, path: route.path, signature: route.signature, mode: route.mode }));
  return {
    ...(block === undefined || routes.length === 0 ? {} : { listen: `${block.host}:${String(block.port)}` }),
    routes,
    last: readDeliveries(profileDir, limit),
  };
}

/** Plain lines, newest delivery last; the surface adds its own theme. */
export function webhookStatusLines(view: WebhookStatusView): string[] {
  if (view.routes.length === 0 && view.last.length === 0) return ["no webhook routes configured (gateway.webhooks.routes)"];
  const lines = [
    view.listen === undefined
      ? "no webhook routes configured (gateway.webhooks.routes)"
      : `${String(view.routes.length)} webhook route(s), served on ${view.listen} while the gateway runs`,
  ];
  for (const route of view.routes) lines.push(`  ${route.name.padEnd(16, " ")} ${route.path.padEnd(24, " ")} ${route.signature.padEnd(20, " ")} ${route.mode}`);
  if (view.last.length > 0) lines.push("last deliveries:");
  for (const row of view.last) {
    const run = row.run_id === undefined ? "" : ` ${row.run_id}`;
    const key = row.key === undefined ? "" : ` key ${row.key}`;
    const status = row.status === undefined ? "" : ` ${String(row.status)}`;
    lines.push(`  ${row.at} ${row.route} ${row.verdict}${status}${run}${key}`);
  }
  return lines;
}
