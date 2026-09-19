/**
 * User hooks: an executable and an argument array Trent runs around a tool call or a session,
 * never a shell string. The command is spawned with `shell: false`, so no tool argument, tool
 * result or model output is ever interpolated into something a shell parses.
 *
 * A hook receives ONE JSON document on stdin and answers with its exit code:
 *   - `pre_tool_call` non-zero blocks the call; the tail of its stderr becomes the reason.
 *   - `post_tool_call` exit codes are logged and never block; the call has already run.
 *   - `session_start` / `session_stop` are advisory in the same way as a post hook.
 *
 * Hooks run only if consented (`hooks/consent.ts`). An unconsented or changed spec never runs.
 */
import { z } from "zod";

export const HOOK_KINDS = ["pre_tool_call", "post_tool_call", "session_start", "session_stop"] as const;
export const HookKindSchema = z.enum(HOOK_KINDS);
export type HookKind = z.infer<typeof HookKindSchema>;

/** Default wall-clock ceiling for one hook. A hook past it is killed and treated as a failure. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

export const HookSpecSchema = z
  .object({
    /** argv: the executable first, then its arguments. Never a shell string. */
    command: z.array(z.string().min(1)).min(1),
    timeout_ms: z.number().int().positive().optional(),
    match: z.object({ tool: z.string().min(1).optional() }).strict().optional(),
  })
  .strict();
export type HookSpec = z.infer<typeof HookSpecSchema>;

export const HooksConfigSchema = z.object({
  pre_tool_call: z.array(HookSpecSchema).default([]),
  post_tool_call: z.array(HookSpecSchema).default([]),
  session_start: z.array(HookSpecSchema).default([]),
  session_stop: z.array(HookSpecSchema).default([]),
});
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

/** The tool call a hook is told about. Arguments are redacted before they reach stdin. */
export interface HookToolCall {
  readonly adapter: string;
  readonly tool: string;
  readonly args: unknown;
  readonly runId?: string;
  readonly stepId?: string;
  readonly seat?: string;
}

/** What a pre-tool hook decided. `blocked` carries the reason the seat and the user see. */
export type HookGate = { readonly blocked: false } | { readonly blocked: true; readonly reason: string };

/**
 * The seam `tools/index.ts` passes every tool call through. Declared here so the governance
 * dispatcher depends on the shape, not on the hook runner's implementation.
 */
export interface ToolHookPort {
  pre(call: HookToolCall): Promise<HookGate>;
  post(call: HookToolCall, result: { status: string; summary: string }): Promise<void>;
  /** Each distinct skipped-hook notice, once. Read by the run so it reports a silent hook. */
  notices(): readonly string[];
}
