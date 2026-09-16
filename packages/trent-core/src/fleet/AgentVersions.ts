/**
 * T4.1 — versioned agent definitions.
 *
 * A version is an immutable snapshot of what a seat runs as: prompt, model, toolsets and the skill
 * bodies it carries, hashed so two snapshots compare by content. Exactly one version per agent is
 * `live`; `createCandidate` snapshots the current definition, `promote` archives the previous live
 * and records the flip in the improve ledger as an iteration of kind `agent`, so the loop's own
 * `rollback(iterationId)` (`../improve/lifecycle.ts`) puts the previous version back. Labels are
 * the only thing that ever changes on a row, and an archived row is never promoted again: the way
 * back to it is a new candidate, which keeps the history linear and every version reproducible.
 */

import { EXIT, TrentError } from "../errors/index.js";
import { contentHash, newId, nowIso, recordLedger } from "../improve/ledger.js";
import { rollback as rollbackIteration, type RollbackReport } from "../improve/lifecycle.js";
import type { AgentDefinition, AgentVersionRow, ImproveStorePort } from "../store/StorePort.js";

/** The task type every agent-version iteration and ledger row is filed under. */
export const AGENT_VERSION_TASK_TYPE = "definition";

/** Where the current definition of an agent comes from: the profile, or a test's fixture. */
export interface AgentDefinitionSource {
  definition(agentId: string): Promise<AgentDefinition>;
}

export interface AgentVersionsOptions {
  readonly store: ImproveStorePort;
  readonly companyId: string;
  readonly source: AgentDefinitionSource;
  readonly now?: () => string;
}

export interface VersionActor {
  /** Only `"human"` promotes or rolls back, as with every other artifact the loop produces. */
  readonly actor: string;
}

export interface PromoteVersionResult {
  readonly version: AgentVersionRow;
  /** The version archived by this promotion, when there was a live one. */
  readonly previous: AgentVersionRow | undefined;
  /** The ledger iteration that recorded the flip; empty when the version was already live. */
  readonly iterationId: string;
}

export interface AgentVersions {
  /** Snapshots the definition (the source's, or the one given) as the next candidate version. */
  createCandidate(agentId: string, definition?: AgentDefinition): Promise<AgentVersionRow>;
  promote(agentId: string, version: number, options: VersionActor): Promise<PromoteVersionResult>;
  /** Reverses the agent's latest promotion through the improve ledger. */
  rollback(agentId: string, options: VersionActor): Promise<RollbackReport>;
  liveVersion(agentId: string): Promise<AgentVersionRow | undefined>;
  /** Every version of the agent, highest first. */
  list(agentId: string): Promise<AgentVersionRow[]>;
}

/** Content hashes of a definition: the prompt alone, and the skills as a sorted slug/body list. */
export function definitionHashes(definition: AgentDefinition): { promptHash: string; skillsHash: string } {
  const skills = [...definition.skills].sort((a, b) => a.slug.localeCompare(b.slug)).map((s) => `${s.slug}\n${contentHash(s.content)}`);
  return { promptHash: contentHash(definition.prompt), skillsHash: contentHash(skills.join("\n")) };
}

function refuse(operation: string, message: string, agentId: string): TrentError {
  return new TrentError({ code: EXIT.USAGE, operation, message, target: agentId });
}

export function createAgentVersions(options: AgentVersionsOptions): AgentVersions {
  const { store, companyId } = options;
  const now = options.now ?? nowIso;

  const list = (agentId: string) => store.listAgentVersions(companyId, { agentId });
  const liveVersion = async (agentId: string) => (await store.listAgentVersions(companyId, { agentId, label: "live" }))[0];

  async function versionNumbered(agentId: string, version: number): Promise<AgentVersionRow> {
    const row = (await list(agentId)).find((v) => v.version === version);
    if (!row) throw refuse("fleet.versions", `agent ${agentId} has no version ${version}`, agentId);
    return row;
  }

  function requireHuman(operation: string, actor: string, agentId: string): void {
    if (actor !== "human") throw refuse(operation, `refusing to ${operation.split(".").pop()} agent ${agentId}: actor "${actor}" is not a human command`, agentId);
  }

  return {
    async createCandidate(agentId, given) {
      const definition = given ?? (await options.source.definition(agentId));
      const latest = (await list(agentId))[0]?.version ?? 0;
      const row: AgentVersionRow = {
        id: newId("agentv"),
        companyId,
        agentId,
        version: latest + 1,
        ...definitionHashes(definition),
        model: { ...definition.model },
        toolsets: [...definition.toolsets],
        label: "candidate",
        createdAt: now(),
        iterationId: null,
        definition: structuredClone(definition),
      };
      await store.createAgentVersion(row);
      return row;
    },

    async promote(agentId, version, actor) {
      requireHuman("fleet.promote", actor.actor, agentId);
      const target = await versionNumbered(agentId, version);
      if (target.label === "live") return { version: target, previous: undefined, iterationId: "" };
      if (target.label === "archived") {
        throw refuse("fleet.promote", `version ${version} of agent ${agentId} is archived and versions are immutable; create a new candidate to return to it`, agentId);
      }
      const at = now();
      const previous = await liveVersion(agentId);
      const iterationId = newId("iter");
      await store.appendIteration({
        id: iterationId,
        companyId,
        agentId,
        taskType: AGENT_VERSION_TASK_TYPE,
        candidateId: target.id,
        candidateKind: "agent",
        score: null,
        delta: null,
        decision: "promoted",
        triggers: [],
        blockedBy: null,
        inputHash: null,
        verdicts: null,
        createdAt: at,
      });
      if (previous) await store.updateAgentVersion(previous.id, { label: "archived" });
      const promoted = await store.updateAgentVersion(target.id, { label: "live", iterationId });
      await recordLedger(store, {
        action: previous ? "fix" : "promote",
        artifact: { id: promoted.id, companyId, agentId, taskType: AGENT_VERSION_TASK_TYPE, kind: "agent" },
        before: previous?.id ?? null,
        after: promoted.id,
        iterationId,
        actor: actor.actor,
        now: at,
      });
      return { version: promoted, previous, iterationId };
    },

    async rollback(agentId, actor) {
      requireHuman("fleet.rollback", actor.actor, agentId);
      // Highest version first: the latest promotion still standing is the one to reverse. A
      // version's iteration is fixed at promote time, so this order does not depend on clock ties.
      for (const row of await list(agentId)) {
        if (row.iterationId === null) continue;
        const rows = await store.listLedger(companyId, { iterationId: row.iterationId });
        const flip = rows.find((r) => r.action === "promote" || r.action === "fix");
        if (!flip || rows.some((r) => r.action === "rollback")) continue;
        if (flip.before === null) {
          throw refuse("fleet.rollback", `nothing to roll back for agent ${agentId}: its first promotion has no previous live version to restore`, agentId);
        }
        return rollbackIteration(store, row.iterationId, actor.actor, now());
      }
      throw refuse("fleet.rollback", `nothing to roll back for agent ${agentId}: no promotion is on record`, agentId);
    },

    liveVersion,
    list,
  };
}
