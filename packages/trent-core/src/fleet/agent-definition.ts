/**
 * T4.1 — the profile as an `AgentDefinitionSource`: what an installed agent currently runs as.
 *
 *   prompt     the seat prompt through the caller's provider (the improve loop's
 *              `defaultSeatPromptProvider`: the app's seat prompt, plus the specialist prompt,
 *              overridden by a human-promoted GEPA proposal). Injected, so this module never
 *              imports `apps/web` itself and a test can hand it a fixture.
 *   model      the configured provider and model (`config.provider` / `config.model`).
 *   toolsets   the tool names in `<agentsDir>/<id>.json`; the core role toolset for a seat that
 *              was never installed as a file.
 *   skills     the installed skill files the record claims (`<skillsDir>/<slug>.md|.json`), plus
 *              the agent's live improve-loop skills, keyed by task type.
 */

import fs from "node:fs";
import path from "node:path";

import { EXIT, TrentError } from "../errors/index.js";
import { readLiveSkills } from "../improve/lifecycle.js";
import { SkillLoader } from "../skills/SkillLoader.js";
import type { AgentDefinition, ImproveStorePort } from "../store/StorePort.js";
import { CORE_ROLES, CORE_ROLE_TOOLS, type InstalledAgentConfig } from "./AgentInstaller.js";
import type { AgentDefinitionSource } from "./AgentVersions.js";

export interface ProfileDefinitionOptions {
  readonly agentsDir: string;
  readonly skillsDir: string;
  readonly store: ImproveStorePort;
  readonly companyId: string;
  readonly model: { provider: string; model: string };
  readonly prompt: (agentId: string) => Promise<string>;
}

function readRecord(agentsDir: string, agentId: string): Partial<InstalledAgentConfig> | null {
  const file = path.join(agentsDir, `${agentId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<InstalledAgentConfig>;
  } catch {
    return null;
  }
}

export function createProfileDefinitionSource(options: ProfileDefinitionOptions): AgentDefinitionSource {
  return {
    async definition(agentId): Promise<AgentDefinition> {
      const record = readRecord(options.agentsDir, agentId);
      if (!record && !(agentId in CORE_ROLES)) {
        throw new TrentError({ code: EXIT.USAGE, operation: "fleet.versions", message: `agent "${agentId}" is not installed in this profile`, target: agentId });
      }
      const tools = record?.tools ?? [...CORE_ROLE_TOOLS];
      const skills: AgentDefinition["skills"] = [];
      const seen = new Set<string>();
      if (fs.existsSync(options.skillsDir)) {
        const loader = new SkillLoader(options.skillsDir);
        for (const slug of record?.installed_skills ?? []) {
          if (seen.has(slug) || loader.getMetadata(slug) === null) continue;
          seen.add(slug);
          skills.push({ slug, content: loader.loadFull(slug).instructions });
        }
      }
      for (const live of await readLiveSkills(options.store, options.companyId, agentId)) {
        if (seen.has(live.taskType)) continue;
        seen.add(live.taskType);
        skills.push({ slug: live.taskType, content: live.content });
      }
      return {
        prompt: await options.prompt(agentId),
        model: { ...options.model },
        toolsets: tools.map((t) => t.name),
        skills: skills.sort((a, b) => a.slug.localeCompare(b.slug)),
      };
    },
  };
}
