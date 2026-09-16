/**
 * T4.1 — run pinning. A bus hook (`composeBusHooks` in the headless runtime) that, on every
 * `run_start`, snapshots the id of each agent's live version into the run, together with the
 * skill bodies that version carries. From then on the run reads the pinned snapshot: a promote
 * while the run is in flight changes the next run, never this one. This is the same freeze the
 * fleet-memory prelude applies per run (`../fleet-memory/README.md`, "writes land next run"):
 * the prelude is built once and stays byte-identical, and the pinned skills are its source.
 *
 * The snapshot is taken from the store on the event, asynchronously; `flush()` (awaited by the
 * orchestrator wrapper before a run's result settles) drains it. A failed snapshot is reported
 * through `onError` and leaves the run unpinned rather than failing the run.
 */

import type { BusHook } from "../improve/trace-writer.js";
import type { OrcEvent } from "../orchestrator/types.js";
import type { AgentDefinition, ImproveStorePort } from "../store/StorePort.js";

export interface VersionPinHookOptions {
  readonly store: ImproveStorePort;
  /** Diagnostic channel for a failed snapshot. Never receives a prompt body. */
  readonly onError?: (message: string) => void;
}

/** Agent id -> the live version id when the run started. */
export type PinnedVersions = Readonly<Record<string, string>>;

export interface VersionPinHook extends BusHook {
  /** The versions a run was pinned to, once its `run_start` has been processed. */
  pinnedFor(runId: string): PinnedVersions | undefined;
  /** The skill bodies of the pinned version, the view a seat of that run reads. */
  frozenSkillsFor(runId: string, agentId: string): AgentDefinition["skills"] | undefined;
}

interface RunPin {
  readonly versions: Record<string, string>;
  readonly skills: Record<string, AgentDefinition["skills"]>;
}

export function createVersionPinHook(options: VersionPinHookOptions): VersionPinHook {
  const pins = new Map<string, RunPin>();
  const pending = new Set<Promise<void>>();

  async function pin(runId: string, companyId: string): Promise<void> {
    const live = await options.store.listAgentVersions(companyId, { label: "live" });
    const snapshot: RunPin = { versions: {}, skills: {} };
    for (const version of live) {
      snapshot.versions[version.agentId] = version.id;
      snapshot.skills[version.agentId] = structuredClone(version.definition.skills);
    }
    pins.set(runId, snapshot);
  }

  return {
    sink(event: OrcEvent) {
      if (event.kind !== "run_start") return;
      const companyId = event.run?.companyId;
      if (companyId === undefined) return;
      const task = pin(event.runId, companyId).catch((error: unknown) => {
        options.onError?.(`version pin for run ${event.runId} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    async flush() {
      await Promise.all([...pending]);
    },
    pinnedFor: (runId) => pins.get(runId)?.versions,
    frozenSkillsFor: (runId, agentId) => pins.get(runId)?.skills[agentId],
  };
}
