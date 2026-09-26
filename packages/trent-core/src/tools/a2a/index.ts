/**
 * [P2-9] The `a2a` toolset: Trent as an A2A CLIENT (the server is `a2a/A2AServer.ts`).
 *
 *   a2a_list      the configured peers (`a2a.peers`) and the card last discovered for each
 *   a2a_discover  fetch and validate one peer's Agent Card, v1.0 or 0.3.0, and cache it
 *   a2a_send      one message to a peer in the dialect its card advertises; the answer's task id,
 *                 state and text, or its question and the ids to continue with
 *   a2a_history   the tasks this profile started with one peer, from `<profile>/a2a/history.json`
 *
 * Gates, in the order a send meets them: the class floor asks a human at every autonomy level
 * (`a2a_send` is `external_send`), and `execute` calls `requireBoundApproval` with the preview
 * (the peer, its URL and the exact message), so the send runs only against an approval bound to
 * exactly these arguments; the idempotency wrapper keys it (`send`), so a replay in the step is
 * answered from the store; only a configured peer's origin is reachable, and only the endpoint at
 * that origin a card names; every request goes through the egress client (the proxy's allowlist is
 * the second gate) carrying the own-credential marker, so the peer gets its own bearer, read by the
 * NAME `token_env` gives, and never the broker's credential. Everything a peer wrote comes back
 * tagged `untrusted`, which the policy ring reads as an inbound call (`send-after-untrusted`).
 */
import crypto from "node:crypto";
import { A2AClientError, fetchAgentCard, sendA2AMessage, type A2AClientOptions, type A2APeerCard, type FetchLike } from "../../a2a/client.js";
import { boundCallKey, requireBoundApproval, type BoundCall } from "../../governance/bound-approvals.js";
import { toolNameOf } from "../../governance/idempotent-dispatch.js";
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import { isTrentError } from "../../errors/index.js";
import { parseAction, record } from "../action.js";
import { fitSummary, headTail, SUMMARY_LIMIT } from "../spillover.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { renderToolInstructions } from "../web/schemas.js";
import { endpointRefusal, peerToken, profileTokenLookup, resolveTarget, type A2aPeer, type PeerTokenLookup } from "./peers.js";
import { renderCard, renderHistory, renderList, renderReply } from "./render.js";
import { A2A_ADAPTER_NAME, A2A_MESSAGE_MAX_CHARS, A2A_ROUTING_TEXT, A2A_SPECS, A2A_TOOL_CLASSES, A2A_TOOL_NAMES, A2A_TOOL_SCHEMAS, A2A_WRITE_TOOLS } from "./schemas.js";
import { freshCard, readCards, readHistory, recordHistory, writeCard } from "./store.js";

export { A2A_ADAPTER_NAME, A2A_ROUTING_TEXT, A2A_TOOL_NAMES, A2A_TOOL_SCHEMAS, A2A_WRITE_TOOLS } from "./schemas.js";
export type { A2aToolName } from "./schemas.js";

export const A2A_SCOPES: readonly string[] = [A2A_ADAPTER_NAME, ...A2A_TOOL_NAMES];

export interface A2aAdapterOptions {
  readonly peers: readonly A2aPeer[];
  readonly profileDir: string;
  /** The egress client in production; a direct transport in tests. */
  readonly fetchImpl: FetchLike;
  /** Headers every request carries: the egress own-credential marker when `fetchImpl` is the egress client. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Where a peer's bearer is read by name. Defaults to the profile secrets file, then the environment. */
  readonly tokens?: PeerTokenLookup;
  readonly seat?: string;
  readonly now?: () => Date;
}

type Parsed = { readonly tool: string; readonly args: Record<string, unknown> };

/** The arguments exactly as the wrapper keys them: the JSON object, else the raw action. */
function boundArgsOf(action: string): unknown {
  const brace = action.trim().indexOf("{");
  if (brace === -1) return action;
  try {
    return JSON.parse(action.trim().slice(brace)) as unknown;
  } catch {
    return action;
  }
}

/** Why a send cannot run, before anyone is asked; undefined when it can. */
function sendRefusal(peers: readonly A2aPeer[], action: string, args: Record<string, unknown>): string | undefined {
  if (toolNameOf(action) !== "a2a_send") return 'call it by name, as a2a_send {"peer": ..., "message": ...}, so the send is keyed and bound';
  const message = typeof args.message === "string" ? args.message : "";
  if (message.trim() === "") return "message is required and must be non-empty text";
  if (message.length > A2A_MESSAGE_MAX_CHARS) return `message is ${message.length} characters; the limit is ${A2A_MESSAGE_MAX_CHARS}`;
  for (const key of ["task_id", "context_id"] as const) if (args[key] !== undefined && typeof args[key] !== "string") return `${key} must be a string`;
  const target = resolveTarget(peers, args);
  return target.ok ? undefined : target.reason;
}

function previewOf(peers: readonly A2aPeer[], args: Record<string, unknown>): string {
  const target = resolveTarget(peers, args);
  const who = target.ok ? `"${target.peer.name}" (${target.url})` : String(args.peer ?? args.url ?? "");
  const continuing = [typeof args.task_id === "string" ? `task ${args.task_id}` : "", typeof args.context_id === "string" ? `context ${args.context_id}` : ""].filter((part) => part !== "");
  return `a2a_send to ${who}${continuing.length === 0 ? "" : `, continuing ${continuing.join(" in ")}`}: ${JSON.stringify(String(args.message ?? ""))}`;
}

export function createA2aAdapter(options: A2aAdapterOptions): TrentToolAdapter {
  const now = options.now ?? (() => new Date());
  const tokens = options.tokens ?? profileTokenLookup(options.profileDir);
  const client = (token?: string): A2AClientOptions => ({ fetchImpl: options.fetchImpl, ...(options.headers === undefined ? {} : { headers: options.headers }), ...(token === undefined ? {} : { token }) });
  const done = (action: string, text: string, tool: string, untrusted: boolean): ToolCallRecord => {
    const summary = fitSummary(text, options.profileDir, tool, SUMMARY_LIMIT);
    const result = record(A2A_ADAPTER_NAME, action, "completed", summary);
    return untrusted ? { ...result, provenance: "untrusted" } : result;
  };
  const fail = (action: string, text: string): ToolCallRecord => record(A2A_ADAPTER_NAME, action, "failed", headTail(text, SUMMARY_LIMIT));

  function failureOf(action: string, tool: string, error: unknown): ToolCallRecord {
    if (error instanceof A2AClientError && error.kind === "refused") {
      return fail(action, `${tool} did not reach the peer: the egress proxy refused its host (${error.target ?? "unknown"}); add the host to egress.intercept_domains. ${error.message}`);
    }
    if (isTrentError(error) || error instanceof Error) return fail(action, `${tool} failed: ${error.message.split("\n")[0]}`);
    return fail(action, `${tool} failed: ${String(error)}`);
  }

  /** The card for a peer: the cached one while fresh, else fetched, validated and cached. */
  async function cardFor(peer: A2aPeer, url: string, refresh: boolean): Promise<A2APeerCard> {
    const cached = refresh ? undefined : freshCard(options.profileDir, peer.name, now());
    const card = cached?.card ?? (await fetchAgentCard(url, client()));
    const refusal = endpointRefusal(peer, card.endpoint);
    if (refusal !== undefined) throw new A2AClientError("card", "a2a.discover", refusal, card.cardUrl);
    if (cached === undefined) writeCard(options.profileDir, peer.name, card, now());
    return card;
  }

  async function send(action: string, parsed: Parsed): Promise<ToolCallRecord> {
    const refusal = sendRefusal(options.peers, action, parsed.args);
    if (refusal !== undefined) return fail(action, `a2a_send did not run: ${refusal}`);
    const context = currentToolCallContext();
    const call: BoundCall = {
      adapter: A2A_ADAPTER_NAME,
      action,
      tool: toolNameOf(action),
      args: boundArgsOf(action),
      classes: A2A_TOOL_CLASSES.a2a_send ?? [],
      ...(context === undefined ? {} : { runId: context.runId, stepId: context.stepId }),
      ...(options.seat === undefined ? {} : { seat: options.seat }),
    };
    const decision = requireBoundApproval(call, previewOf(options.peers, parsed.args));
    if (!decision.granted) return decision.record;
    const target = resolveTarget(options.peers, parsed.args);
    if (!target.ok) return fail(action, `a2a_send did not run: ${target.reason}`);
    const token = peerToken(target.peer, tokens, options.profileDir);
    if (!token.ok) return fail(action, `a2a_send did not run: ${token.reason}`);
    const card = await cardFor(target.peer, target.url, false);
    if (card.requiresAuth && token.token === undefined) return fail(action, `a2a_send did not run: the card of "${target.peer.name}" requires a bearer and its a2a.peers entry names no token_env`);
    const text = String(parsed.args.message);
    // Inside a run the message id is derived from the bound-call key, so a replay that reaches the peer anyway is one message to a peer that dedupes.
    const messageId = context === undefined ? crypto.randomUUID() : `trent-${boundCallKey(call).slice(0, 32)}`;
    const reply = await sendA2AMessage(
      {
        endpoint: card.endpoint,
        dialect: card.dialect,
        text,
        messageId,
        ...(typeof parsed.args.task_id === "string" ? { taskId: parsed.args.task_id } : {}),
        ...(typeof parsed.args.context_id === "string" ? { contextId: parsed.args.context_id } : {}),
      },
      client(token.token),
    );
    recordHistory(options.profileDir, {
      peer: target.peer.name,
      ...(reply.taskId === undefined ? {} : { taskId: reply.taskId }),
      ...(reply.contextId === undefined ? {} : { contextId: reply.contextId }),
      state: reply.state,
      dialect: card.dialect,
      endpoint: card.endpoint,
      sent: text,
      reply: reply.text,
      ...(reply.question === undefined ? {} : { question: reply.question }),
      at: now().toISOString(),
    });
    return done(action, renderReply(target.peer.name, reply), "a2a_send", true);
  }

  async function run(action: string, parsed: Parsed): Promise<ToolCallRecord> {
    switch (parsed.tool) {
      case "a2a_list": {
        const cards = readCards(options.profileDir);
        const anyCard = options.peers.some((peer) => cards[peer.name] !== undefined);
        return done(action, renderList(options.peers, cards, (name) => tokens(name) !== undefined), "a2a_list", anyCard);
      }
      case "a2a_discover": {
        const target = resolveTarget(options.peers, parsed.args);
        if (!target.ok) return fail(action, `a2a_discover did not run: ${target.reason}`);
        return done(action, renderCard(target.peer.name, await cardFor(target.peer, target.url, true)), "a2a_discover", true);
      }
      case "a2a_history": {
        const target = resolveTarget(options.peers, parsed.args);
        if (!target.ok) return fail(action, `a2a_history did not run: ${target.reason}`);
        const contextId = typeof parsed.args.context_id === "string" ? parsed.args.context_id : undefined;
        const rows = readHistory(options.profileDir).filter((row) => row.peer === target.peer.name && (contextId === undefined || row.contextId === contextId));
        return done(action, renderHistory(target.peer.name, rows, contextId), "a2a_history", rows.length > 0);
      }
      case "a2a_send":
        return send(action, parsed);
      default:
        return fail(action, `unknown a2a tool ${parsed.tool}`);
    }
  }

  return {
    name: A2A_ADAPTER_NAME,
    scopes: [...A2A_SCOPES],
    availability: "real",
    instructions: renderToolInstructions(A2A_TOOL_SCHEMAS),
    routingText: A2A_ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval(action) {
      const parsed = parseAction(action, A2A_SPECS);
      return !parsed.error && A2A_WRITE_TOOLS.has(parsed.tool);
    },
    preview(action) {
      const parsed = parseAction(action, A2A_SPECS);
      if (parsed.error || !A2A_WRITE_TOOLS.has(parsed.tool)) return undefined;
      const refusal = sendRefusal(options.peers, action, parsed.args);
      return refusal === undefined ? previewOf(options.peers, parsed.args) : `a2a_send cannot run: ${refusal}`;
    },
    async dryRun(action) {
      const parsed = parseAction(action, A2A_SPECS);
      if (parsed.error) return fail(action, parsed.error);
      if (!A2A_WRITE_TOOLS.has(parsed.tool)) return record(A2A_ADAPTER_NAME, action, "completed", `${parsed.tool} sends nothing; it runs without approval.`);
      const refusal = sendRefusal(options.peers, action, parsed.args);
      if (refusal !== undefined) return fail(action, `a2a_send cannot run: ${refusal}`);
      return record(A2A_ADAPTER_NAME, action, "needs_approval", `a2a: a2a_send sends nothing until exactly this call is approved: ${previewOf(options.peers, parsed.args)}`);
    },
    async execute(action) {
      const parsed = parseAction(action, A2A_SPECS);
      if (parsed.error) return fail(action, parsed.error);
      try {
        return await run(action, parsed);
      } catch (error) {
        return failureOf(action, parsed.tool, error);
      }
    },
    cleanup: async () => undefined,
  };
}
