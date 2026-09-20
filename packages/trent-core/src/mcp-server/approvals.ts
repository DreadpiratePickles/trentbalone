/**
 * U5 / G9 — approvals for calls that arrive over MCP.
 *
 * A seat's approval is decided by the surface that runs the seat; a host agent has no such
 * surface, and the xAI Remote MCP API cannot relay an interrupt at all (research 1d). So a gated
 * call is parked as a durable row in this profile's `gateway.json`, the file `trent approvals`
 * lists and decides through `ApprovalBridge`, and the host gets a `needs_approval` result with
 * the row's id. The founder settles it there; the host calls again; the row is found by the
 * KEY of the call (run, tool, arguments), so what was previewed is what is sent (G2), and a yes
 * is spent by exactly one execution. A no is kept, so the host cannot ask its way past it by
 * repeating the call.
 *
 * Rows carry the composed action and the adapter's own preview; nothing is added that the seat
 * path would not have shown the founder.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { ApprovalBridge, FileGatewayStore, type ApprovalRow } from "../gateway/index.js";

/** The `details.surface` every MCP row carries, so a reader can tell it from a run's row. */
export const MCP_APPROVAL_SURFACE = "mcp";

export type McpApprovalStatus = ApprovalRow["status"];

export interface McpApproval {
  readonly id: string;
  readonly status: McpApprovalStatus;
  readonly preview: string;
}

export interface McpApprovalRequest {
  readonly key: string;
  /** The composed `<tool> <json>` action, exactly what the adapter will be handed. */
  readonly action: string;
  /** What the adapter's dry run said would happen. */
  readonly preview: string;
}

export interface McpApprovalGate {
  /** The pending, approved-and-unspent or denied row for this key; undefined when the call must ask. */
  lookup(key: string): McpApproval | undefined;
  /** The row for this key, opened now when none is open. */
  request(input: McpApprovalRequest): McpApproval;
  /** Marks an approved row as used by one execution; the next identical call asks again. */
  spend(id: string): void;
}

export interface McpApprovalGateOptions {
  readonly profileDir: string;
  /** `mcp:<client name>`, so `trent approvals list` says which host asked. */
  readonly agentId: string;
  /** The connection's run id, so the row and the idempotency key name the same scope. */
  readonly runId: string;
}

/** Stable JSON: keys sorted at every level, so `{a,b}` and `{b,a}` are one call. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The key one call is approved under: the connection's run, the tool and its arguments. */
export function approvalKey(runId: string, tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${runId}\n${tool}\n${canonical(args)}`).digest("hex").slice(0, 32);
}

function detailsOf(row: ApprovalRow): { surface?: unknown; key?: unknown; preview?: unknown; spent_at?: unknown } {
  return row.details as { surface?: unknown; key?: unknown; preview?: unknown; spent_at?: unknown };
}

function toApproval(row: ApprovalRow): McpApproval {
  const preview = detailsOf(row).preview;
  return { id: row.id, status: row.status, preview: typeof preview === "string" ? preview : "" };
}

export function createMcpApprovalGate(options: McpApprovalGateOptions): McpApprovalGate {
  const store = new FileGatewayStore(path.join(options.profileDir, "gateway.json"));
  const bridge = new ApprovalBridge({ store });

  const rowsFor = (key: string): ApprovalRow[] =>
    Object.values(store.snapshot().approvals)
      .filter((row) => {
        const details = detailsOf(row);
        return details.surface === MCP_APPROVAL_SURFACE && details.key === key && row.runId === options.runId;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const lookup = (key: string): McpApproval | undefined => {
    // The newest row for the key decides: a spent yes leaves nothing open, a no stays a no.
    const row = rowsFor(key).at(-1);
    if (row === undefined) return undefined;
    if (row.status === "approved" && detailsOf(row).spent_at !== undefined) return undefined;
    if (row.status === "expired") return undefined;
    return toApproval(row);
  };

  return {
    lookup,
    request(input) {
      const open = lookup(input.key);
      if (open !== undefined) return open;
      const row = bridge.createApprovalRequest(
        options.agentId,
        input.action,
        { surface: MCP_APPROVAL_SURFACE, key: input.key, preview: input.preview },
        { runId: options.runId, kind: "approval" },
      );
      return toApproval(row);
    },
    spend(id) {
      store.mutate((state) => {
        const row = state.approvals[id];
        if (row !== undefined) row.details = { ...row.details, spent_at: new Date().toISOString() };
      });
    },
  };
}
