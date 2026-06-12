import type { ToolCallRecord } from "@/lib/types";

export const INTERNAL_ACTIONS = new Set<string>();

export type InternalActionContext = {
  companyId: string;
  actor?: string;
  payload?: Record<string, unknown>;
};

export async function runInternalAction(
  tool: string,
  action: string,
  _ctx: InternalActionContext,
): Promise<ToolCallRecord> {
  return {
    adapter: tool,
    action,
    status: "failed",
    summary: `Internal action "${tool}" is not implemented.`,
  };
}
