/**
 * [S3] Solo continuity in the runtime: what each solo runner gets beyond S2's wiring
 * (`runner-for-mode.ts` calls these; `docs/sessions/2026-09-26-s3-solo-continuity.md`).
 *
 *   settings       `agent.solo.delegate` (solo | fleet | off), `agent.solo.max_delegation_depth`,
 *                  `agent.solo.compact_after_chars`, `agent.solo.auto_compact`. The `agent` block is a
 *                  passthrough, so they are validated here, where they are read, and a wrong value is
 *                  refused out loud rather than read as the default.
 *   memory         the fleet-memory hook's adapters behind the provenance gate and the durable hold: the
 *                  orchestrator appends them after the gate chain, so solo gates them itself (item 2).
 *   skills         the profile's skills store (item 3).
 *   delegation     a child solo runner on a new session of the same store for a stored conversation, in
 *                  memory for a one-off; a child fleet run through the runtime's fleet runner (item 4).
 *   conversations  the runners built per conversation key, handed to the router as its `create`, so
 *                  `/compact` and the rollback note reach the SAME runner the router drives. This is the
 *                  hook that stands in for a router change (`compactConversation`, `noteConversation`)
 *                  the coordinator put out of this wave's reach while S2's router is being landed.
 */
import path from "node:path";
import type { SessionManager } from "@trent/core";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { FleetMemoryHook } from "@trent/core/fleet-memory/index.js";
import type { ProvenancePolicy } from "@trent/core/governance/provenance.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { SoloCompactionSettings } from "@trent/core/solo/compaction.js";
import { DEFAULT_SOLO_MAX_DELEGATION_DEPTH, SOLO_DELEGATE_MODES, createSoloDelegation, seededState, soloChildFactory, type SoloChildBase, type SoloDelegateMode, type SoloDelegation } from "@trent/core/solo/delegate.js";
import { clip } from "@trent/core/solo/events.js";
import type { SoloHoldPolicy } from "@trent/core/solo/hold-policy.js";
import { gatedMemoryAdapters } from "@trent/core/solo/memory-gate.js";
import { sessionStoreState } from "@trent/core/solo/park.js";
import type { SoloConversation, SoloFrameSink } from "@trent/core/solo/router.js";
import { memorySoloSession, profileSoloSession } from "@trent/core/solo/session-store.js";
import { profileSoloSkills, type SoloSkills } from "@trent/core/solo/skills.js";
import { SOLO_SEAT, type SoloRunner } from "@trent/core/solo/types.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";

export interface SoloAgentSettings {
  readonly delegate: SoloDelegateMode;
  readonly maxDelegationDepth: number;
  readonly compaction: SoloCompactionSettings;
}

function refuse(key: string, value: unknown, wanted: string): TrentError {
  return new TrentError({ code: EXIT.CONFIG, operation: "config.agent.solo", message: `${key} is ${JSON.stringify(value)}; it must be ${wanted}`, target: key });
}

/** `agent.solo.*`, validated where it is read. Absent keys are the defaults. */
export function soloAgentSettings(config: unknown): SoloAgentSettings {
  const raw = (config as { agent?: { solo?: unknown } }).agent?.solo;
  const solo = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const { delegate, max_delegation_depth: depth, compact_after_chars: after, auto_compact: auto } = solo;
  if (delegate !== undefined && !SOLO_DELEGATE_MODES.includes(delegate as SoloDelegateMode)) throw refuse("agent.solo.delegate", delegate, SOLO_DELEGATE_MODES.join(", "));
  if (depth !== undefined && !(typeof depth === "number" && Number.isInteger(depth) && depth >= 0)) throw refuse("agent.solo.max_delegation_depth", depth, "a whole number, 0 or more");
  if (after !== undefined && !(typeof after === "number" && Number.isInteger(after) && after > 0)) throw refuse("agent.solo.compact_after_chars", after, "a whole number of characters, above 0");
  if (auto !== undefined && typeof auto !== "boolean") throw refuse("agent.solo.auto_compact", auto, "true or false");
  return {
    delegate: (delegate as SoloDelegateMode | undefined) ?? "solo",
    maxDelegationDepth: (depth as number | undefined) ?? DEFAULT_SOLO_MAX_DELEGATION_DEPTH,
    compaction: { ...(after === undefined ? {} : { compactAfterChars: after as number }), ...(auto === undefined ? {} : { auto: auto as boolean }) },
  };
}

/** The fleet-memory hook's adapters behind the provenance gate, holds filed in this profile (item 2). */
export function soloMemoryAdapters(hook: FleetMemoryHook, profileDir: string, config: unknown): TrentToolAdapter[] {
  const policy = (config as { provenance?: ProvenancePolicy }).provenance;
  return gatedMemoryAdapters(hook.adapters, { profileDir, ...(policy === undefined ? {} : { policy }) });
}

/** The profile's skills store, where `skill_view` reads (`tools/skills`). */
export function soloSkillsOf(profileDir: string): SoloSkills {
  return profileSoloSkills(path.join(profileDir, "skills"));
}

export interface SoloDelegationWiring {
  readonly settings: SoloAgentSettings;
  readonly base: SoloChildBase;
  /** The adapters a conversation's runner gets before its hold policy: the child gets them with holds refused. */
  readonly adapters: readonly TrentToolAdapter[];
  readonly sessions: SessionManager;
  readonly model: { readonly provider: string; readonly model: string };
  /** A child fleet run, for `agent.solo.delegate: fleet`. */
  readonly fleetRun?: (objective: string, signal?: AbortSignal) => AsyncIterable<OrcEvent>;
  readonly sinks?: readonly SoloFrameSink[];
}

/** One delegation for every conversation of the runtime: a child's conversation follows its parent's. */
export function soloDelegationFor(wiring: SoloDelegationWiring): SoloDelegation {
  let delegation: SoloDelegation | undefined;
  const createChild = soloChildFactory({
    base: wiring.base,
    adapters: wiring.adapters,
    conversation: (spec) => {
      if (spec.parentSessionId === undefined) return { session: memorySoloSession(), state: seededState(spec.taint) };
      // A child of a stored conversation is stored beside it, in the same store, named for what it was asked.
      const id = wiring.sessions.startSession(SOLO_SEAT, wiring.model.model, wiring.model.provider, clip(`delegated: ${spec.objective}`, 60)).id;
      return { session: profileSoloSession(wiring.sessions, id), state: sessionStoreState(wiring.sessions.getStore(), id), sessionId: id };
    },
    delegation: () => delegation as SoloDelegation,
  });
  delegation = createSoloDelegation({
    mode: wiring.settings.delegate,
    maxDepth: wiring.settings.maxDelegationDepth,
    createChild,
    ...(wiring.fleetRun === undefined ? {} : { fleet: wiring.fleetRun }),
    ...(wiring.sinks === undefined ? {} : { sinks: wiring.sinks }),
  });
  return delegation;
}

/** The runners built per conversation: the router's `create`, and the same runner for `/compact` and a note. */
export interface ConversationRunners {
  create(conversation: SoloConversation): SoloRunner;
  /** A profile session's runner: the one the router drives, built now (and adopted by the router) if none is. */
  forSession(sessionId: string): SoloRunner;
}

export function conversationRunners(build: (conversation: SoloConversation) => SoloRunner, holds: SoloHoldPolicy): ConversationRunners {
  const built = new Map<string, SoloRunner>();
  const create = (conversation: SoloConversation): SoloRunner => {
    // A one-off leaves with its run: the router drops it, and so does this map by never keeping it.
    if (conversation.key.startsWith("once:")) return build(conversation);
    const existing = built.get(conversation.key);
    if (existing !== undefined) return existing;
    const runner = build(conversation);
    built.set(conversation.key, runner);
    return runner;
  };
  // The router's own key and default policy for a session conversation (`router.ts` `open`).
  return { create, forSession: (sessionId) => create({ key: `session:${sessionId}`, sessionId, holds }) };
}
