/**
 * [S3] Fakes for the continuity tests. Nothing here calls a model: the gateway tells the three kinds
 * of call apart by their system prompt (a turn, the compaction's memory flush, its summary) and
 * answers each from its own script, so a test can assert which calls were made and in what order.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContextBlock } from "../fleet-memory/tiers.js";
import type { GatewayStreamRequest } from "../model-gateway/types.js";
import { createMemoryAdapter, type MemoryAdapter } from "../tools/memory/index.js";
import { SOLO_SUMMARY_PROMPT } from "./compaction.js";
import { completion } from "./fakes.test-helpers.js";
import type { SoloGateway, SoloMemory } from "./types.js";

/**
 * The flush's own system prompt (`sessions/compaction.ts` FLUSH_SYSTEM_PROMPT) opens with this and asks
 * for a JSON array. Not "durable facts" alone: the memory tool's own block description says that too.
 */
const FLUSH_OPENING = "You are compacting a work session.";

export type CallKind = "turn" | "flush" | "summary";

export interface RoutedGateway extends SoloGateway {
  readonly requests: GatewayStreamRequest[];
  /** The kind of every call, in order. */
  readonly kinds: CallKind[];
}

export function kindOf(request: GatewayStreamRequest): CallKind {
  const system = request.messages[0]?.role === "system" ? request.messages[0].content : "";
  if (system === SOLO_SUMMARY_PROMPT) return "summary";
  if (system.startsWith(FLUSH_OPENING) && system.includes("JSON array")) return "flush";
  return "turn";
}

export function routedGateway(turns: readonly string[], extra: { flush?: readonly string[]; summary?: readonly string[] } = {}): RoutedGateway {
  const requests: GatewayStreamRequest[] = [];
  const kinds: CallKind[] = [];
  const next = { turn: 0, flush: 0, summary: 0 };
  const scripts: Record<CallKind, readonly string[]> = { turn: turns, flush: extra.flush ?? [], summary: extra.summary ?? [] };
  return {
    requests,
    kinds,
    async complete(request) {
      requests.push(request);
      const kind = kindOf(request);
      kinds.push(kind);
      const reply = scripts[kind][next[kind]++];
      if (reply === undefined) throw new Error(`the test script has no ${kind} reply for call ${String(next[kind])}`);
      return completion(reply);
    },
  };
}

export const SUMMARY_REPLY = [
  "## Goal",
  "Plan the oak shop's autumn catalogue.",
  "## Constraints",
  "none",
  "## Progress",
  "Read the notes.",
  "## Decisions",
  "Walnut stain.",
  "## Files",
  "notes.md",
  "## Next steps",
  "Draft the catalogue.",
].join("\n");

export function tempProfile(prefix = "trent-solo-s3-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function memoryFile(profileDir: string): string {
  return path.join(profileDir, "memories", "MEMORY.md");
}

export function readMemory(profileDir: string): string {
  try {
    return fs.readFileSync(memoryFile(profileDir), "utf8");
  } catch {
    return "";
  }
}

/** A real `memory` adapter over the profile's own blocks. */
export function realMemoryAdapter(profileDir: string): MemoryAdapter {
  return createMemoryAdapter({ profileDir });
}

/** A memory port whose stable tier is MEMORY.md as it stands NOW, so a rebuilt prefix would show a later write. */
export function liveMemory(profileDir: string, context: readonly ContextBlock[] = []): SoloMemory {
  return async () => ({
    stable: [{ tier: "stable", name: "company-memory", text: `## Company memory\n${readMemory(profileDir) || "(empty)"}` }],
    context,
  });
}

/** Every message after the system prompt, as one string: what the model was told. */
export const toldIn = (request: GatewayStreamRequest | undefined): string =>
  (request?.messages ?? []).filter((message) => message.role !== "system").map((message) => message.content).join("\n");

export const systemIn = (request: GatewayStreamRequest | undefined): string => request?.messages.find((message) => message.role === "system")?.content ?? "";

/** The text of `n` characters, recognisable in a transcript. */
export const filler = (label: string, n: number): string => `${label}: ${"x".repeat(Math.max(0, n - label.length - 2))}`;
