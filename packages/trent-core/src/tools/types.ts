/**
 * Local mirror of the `apps/web` tool contract, redeclared for the same reason `orchestrator/types.ts`
 * is: a type import from `@/lib/tools` makes `tsc` load the whole application graph. The wrapper casts
 * the structurally identical values across the boundary once, in `orchestrator/seat-wiring.ts`.
 *
 * Source of truth, kept in sync by hand:
 *   - `apps/web/lib/tools.ts:22-37`   (ToolAdapter)
 *   - `apps/web/lib/types.ts:385-390` (ToolCallRecord)
 */

export type ToolCallStatus = "mocked" | "completed" | "needs_approval" | "failed" | "blocked";

/**
 * [C5] Where the bytes in `summary` came from. `untrusted` means the result is derived from
 * content nobody on this machine authored — a web page, an MCP server, a plugin, or a delegated
 * child that read one of those. Optional because the app's own adapters (`apps/web/lib/tools.ts`,
 * read-only) do not set it; absent is read as `trusted` by `provenanceOf`.
 */
export type Provenance = "trusted" | "untrusted";

export interface ToolCallRecord {
  adapter: string;
  action: string;
  status: ToolCallStatus;
  /** The only channel back to the model: everything a tool returns is this string. */
  summary: string;
  /** [C5] Set by the provenance wrapper (`governance/provenance.ts`) on every call it sees. */
  provenance?: Provenance;
}

export interface ToolAdapter {
  name: string;
  scopes: string[];
  availability?: "real" | "unavailable" | "test_only";
  spendsMoneyOnExecute?: boolean;
  approvalExpiryHours?: number;
  healthCheck: (companyId?: string) => Promise<"mocked" | "connected" | "needs_credentials">;
  estimateCost: () => number;
  requiresApproval: (action: string) => boolean;
  execute: (action: string, payload: Record<string, unknown>) => Promise<ToolCallRecord>;
  dryRun?: (action: string, payload: Record<string, unknown>) => Promise<ToolCallRecord>;
  fallbackAdapterName?: string;
}

/**
 * [D5] One tool description a promoted improvement draft replaced (`improve/tool-overrides.ts`).
 * It carries the draft it came from, so a surface can say which improvement is talking. Only the
 * description is ever overridden: never the schema, never the handler.
 */
export interface ToolDescriptionOverride {
  readonly tool: string;
  readonly description: string;
  readonly draftId: string;
  readonly promotedAt: string;
}

/** A Trent toolset adapter: one catalog entry per Hermes toolset, plus what the seat needs to use it. */
export interface TrentToolAdapter extends ToolAdapter {
  /** Appended to the seat's `toolInstructions` so the model learns the `<tool> <json>` action shape. */
  readonly instructions: string;
  /**
   * [D5] The promoted descriptions this adapter is serving instead of its shipped ones. Absent on
   * every adapter the profile has not overridden, which is all of them until a human promotes one.
   */
  readonly descriptionOverrides?: readonly ToolDescriptionOverride[];
  /** Read by the semantic router's catalog through the `registerExternalAdapters` seam. */
  readonly routingText: string;
  /**
   * [U1] The exact content or amount a call would send, rendered for the human who approves it
   * (`governance/bound-approvals.ts`). Absent, or answering nothing, the arguments are shown as
   * written. An adapter that posts, sends, books, invoices or charges should answer.
   */
  readonly preview?: (action: string) => string | undefined;
  /** Releases sandboxes and background processes. */
  cleanup(): Promise<void>;
}

/** Where a toolset runs: the workspace it may touch and the profile it may spill into. */
export interface ToolContext {
  /** Absolute host path of the repository the seats work in. */
  readonly workspace: string;
  /** Absolute host path of the Trent profile (`~/.trent/<profile>`); spillover lands under `cache/`. */
  readonly profileDir: string;
  readonly backend: "docker" | "local";
  readonly docker?: {
    readonly image: string;
    /** Bridge network used only for commands that need egress; `none` otherwise. */
    readonly bridgeNetwork?: string;
  };
  /** When set, egress-needing commands run behind the proxy; without it they have no network at all. */
  readonly egress?: {
    /** As reachable FROM the sandbox, e.g. `http://host.docker.internal:8089`. */
    readonly proxyUrl: string;
    readonly token: string;
    readonly caCertPath: string;
    readonly credentialEnvNames?: readonly string[];
  };
  /** Writes to a normal file skip the approval gate; protected instruction files never do. */
  readonly autoApproveWrites?: boolean;
}
