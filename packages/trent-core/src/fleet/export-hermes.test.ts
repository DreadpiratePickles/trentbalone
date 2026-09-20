/**
 * W5 — `fleet export --target hermes`: a seat (or a pack) as a Hermes profile distribution.
 * `renderHermesProfile` is a pure function over the bundle: the manifest parses as YAML with the
 * fields Hermes reads, `SOUL.md` carries the persona and the seat prompt, `config.yaml` maps the
 * seat's toolsets onto Hermes's names one to one where the names are shared, `mcp.json` points at
 * `trent mcp serve --stdio`, `env_requires` names provider env names and never a value, and the
 * archive holds exactly one top-level directory, as `hermes profile import` demands.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { ToolsetSchema } from "../config/schema.js";
import { connectProvider } from "../connect/providers.js";
import { InMemoryImproveStore } from "../improve/memory-store.js";
import { parseFrontmatter } from "../skills/skill-store.js";
import type { AgentDefinition } from "../store/StorePort.js";
import { createAgentVersions, type AgentDefinitionSource } from "./AgentVersions.js";
import { exportAgent, importAgent, type AgentBundle } from "./export.js";
import {
  CONNECT_PROVIDERS_BY_TOOLSET,
  HERMES_MCP_SERVER_NAME,
  HERMES_TOOLSET_NAMES,
  exportHermesProfiles,
  hermesProfileName,
  renderHermesProfile,
} from "./export-hermes.js";
import { seatCapability } from "./seat-capabilities.js";

const dirs: string[] = [];
const tmp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trent-${label}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function source(): AgentDefinitionSource {
  return {
    async definition(agentId): Promise<AgentDefinition> {
      return {
        prompt: `You are the ${agentId} seat. Ship small commits.`,
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
        toolsets: agentId === "finance" ? ["file_ops"] : ["file_ops", "terminal"],
        skills: [{ slug: "repo-audit", content: "# Repository Audit\n> Map the codebase.\n\nList every package." }],
      };
    },
  };
}

function versions() {
  return createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co", source: source() });
}

async function bundleFor(agentId: string): Promise<AgentBundle> {
  return (await exportAgent({ versions: versions(), agentId, dir: tmp("bundle") })).bundle;
}

/** The member names of a gzipped ustar archive, in order. */
function tarMembers(archive: string): string[] {
  const tar = gunzipSync(fs.readFileSync(archive));
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe("renderHermesProfile is a pure function over the bundle", () => {
  it("writes a manifest, SOUL.md, config.yaml and mcp.json that parse and carry the seat", async () => {
    const bundle = await bundleFor("engineer");
    const profile = renderHermesProfile(bundle, { descriptions: new Map([["repo-audit", "Map the codebase."]]), profile: "default" });
    expect(profile.name).toBe("trent-engineer");
    const again = renderHermesProfile(bundle, { descriptions: new Map([["repo-audit", "Map the codebase."]]), profile: "default" });
    expect(again.files).toEqual(profile.files);

    const manifest = parseYaml(profile.files["distribution.yaml"]!) as { name: string; version: string; description: string; hermes_requires?: string; distribution_owned: string[]; env_requires: Array<{ name: string; required?: boolean; default?: string }> };
    expect(manifest.name).toBe("trent-engineer");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description.length).toBeGreaterThan(10);
    expect(manifest.distribution_owned).toEqual(expect.arrayContaining(["SOUL.md", "config.yaml", "mcp.json", "skills", "distribution.yaml"]));
    expect(manifest.distribution_owned).not.toContain("agent.json");

    const soul = profile.files["SOUL.md"]!;
    expect(soul).toContain("Ship small commits.");
    expect(soul).toContain("trent approvals approve");
    for (const gate of seatCapability("engineer").approvalGates) expect(soul).toContain(gate);
    expect(soul).toContain("repo-audit");

    const config = parseYaml(profile.files["config.yaml"]!) as { platform_toolsets: { cli: string[] }; agent: { disabled_toolsets: string[] }; mcp_servers: Record<string, { command: string; args: string[]; env: Record<string, string> }>; model?: unknown };
    const seat = seatCapability("engineer");
    for (const toolset of seat.toolsets) {
      const hermes = HERMES_TOOLSET_NAMES[toolset];
      if (hermes !== null && hermes !== undefined) expect(config.platform_toolsets.cli, toolset).toContain(hermes);
    }
    expect(config.platform_toolsets.cli).toContain(HERMES_MCP_SERVER_NAME);
    expect(config.agent.disabled_toolsets).toEqual(seat.denied.map((toolset) => HERMES_TOOLSET_NAMES[toolset]).filter((name) => name !== null && name !== undefined));
    expect(config.model).toBeUndefined();
    const server = config.mcp_servers[HERMES_MCP_SERVER_NAME]!;
    expect(server.command).toBe("trent");
    expect(server.args).toEqual(["mcp", "serve", "--stdio", "--profile", "default"]);
    expect(server.env).toEqual({ TRENT_QUEUE_FALLBACK: "disabled" });

    const mcp = JSON.parse(profile.files["mcp.json"]!) as { $schema: string; mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }> };
    expect(mcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(mcp.mcpServers[HERMES_MCP_SERVER_NAME]).toEqual({ type: "stdio", command: "trent", args: ["mcp", "serve", "--stdio", "--profile", "default"], env: { TRENT_QUEUE_FALLBACK: "disabled" } });
    expect(profile.files["README.md"]).toContain("hermes profile install");
  });

  it("maps every Trent toolset: the shared names one to one, Hermes's own spelling for the rest, none invented", () => {
    for (const toolset of ToolsetSchema.options) expect(toolset in HERMES_TOOLSET_NAMES, toolset).toBe(true);
    for (const shared of ["terminal", "web", "browser", "vision", "memory", "delegation", "skills"]) expect(HERMES_TOOLSET_NAMES[shared]).toBe(shared);
    expect(HERMES_TOOLSET_NAMES.file_ops).toBe("file");
    expect(HERMES_TOOLSET_NAMES.cron).toBe("cronjob");
    expect(HERMES_TOOLSET_NAMES.code).toBe("code_execution");
    expect(HERMES_TOOLSET_NAMES.human).toBe("clarify");
    // Hermes has no toolset for these; they reach the host through the trent MCP server only.
    expect(HERMES_TOOLSET_NAMES.plugins).toBeNull();
    expect(HERMES_TOOLSET_NAMES.mcp).toBeNull();
    expect(HERMES_TOOLSET_NAMES.media).toBeNull();
  });

  it("names the provider env names of the seat's toolsets in env_requires, never a value, and never requires them", async () => {
    const bundle = await bundleFor("engineer");
    const withBusiness: AgentBundle = { ...bundle, seat: { ...bundle.seat!, toolsets: [...bundle.seat!.toolsets, "business"] } };
    const profile = renderHermesProfile(withBusiness, { descriptions: new Map() });
    const manifest = parseYaml(profile.files["distribution.yaml"]!) as { env_requires: Array<{ name: string; description: string; required?: boolean; default?: string }> };
    const names = manifest.env_requires.map((entry) => entry.name);
    for (const id of CONNECT_PROVIDERS_BY_TOOLSET.business!) {
      for (const field of connectProvider(id).fields) expect(names).toContain(field.env);
    }
    expect(names).toContain("TRENT_HOME");
    for (const entry of manifest.env_requires) {
      expect(entry.required).toBe(false);
      expect(entry.default).toBeUndefined();
      if (entry.name !== "TRENT_HOME") expect(entry.description, entry.name).toContain("trent connect");
    }
    const example = profile.files[".env.EXAMPLE"]!;
    expect(example).toContain("STRIPE_SECRET_KEY");
    const assignments = example.split("\n").filter((line) => /^#?\s*[A-Z][A-Z0-9_]*=/.test(line));
    expect(assignments.length).toBe(names.length);
    for (const line of assignments) expect(line, line).toMatch(/=$/);
    // A seat with no business or social toolset names no provider at all.
    const plain = parseYaml(renderHermesProfile(bundle, { descriptions: new Map() }).files["distribution.yaml"]!) as { env_requires: Array<{ name: string }> };
    expect(plain.env_requires.map((entry) => entry.name)).toEqual(["TRENT_HOME"]);
  });

  it("derives a profile name Hermes accepts and never a reserved one", () => {
    expect(hermesProfileName("engineer")).toBe("trent-engineer");
    expect(hermesProfileName("My.Analyst_2")).toBe("trent-my-analyst_2");
    expect(hermesProfileName("x".repeat(80))).toHaveLength(64);
  });
});

describe("exportHermesProfiles for one seat", () => {
  it("writes the distribution beside the plain bundle, the skills in the Agent Skills layout, and one archive with one root", async () => {
    const out = tmp("hermes-seat");
    const result = await exportHermesProfiles({ versions: versions(), target: "engineer", dir: out, profileDir: tmp("profile"), profile: "default" });
    expect(result.agents).toEqual(["engineer"]);
    expect(result.persona).toBe(false);
    expect(result.profiles).toHaveLength(1);
    const profile = result.profiles[0]!;
    expect(profile.name).toBe("trent-engineer");
    expect(profile.dir).toBe(out);
    for (const relative of ["distribution.yaml", "SOUL.md", "config.yaml", "mcp.json", "README.md", ".env.EXAMPLE", "agent.json", path.join("skills", "repo-audit", "SKILL.md"), "trent-engineer.tar.gz"]) {
      expect(result.files.map((f) => path.relative(out, f)), relative).toContain(relative);
      expect(fs.existsSync(path.join(out, relative)), relative).toBe(true);
    }
    const skill = parseFrontmatter(fs.readFileSync(path.join(out, "skills", "repo-audit", "SKILL.md"), "utf8"));
    expect(skill.fields.name).toBe("repo-audit");
    expect(skill.fields.description).toBe("Map the codebase.");

    const members = tarMembers(profile.archive);
    expect(members.length).toBeGreaterThan(5);
    const roots = new Set(members.map((name) => name.split("/")[0]));
    expect([...roots]).toEqual(["trent-engineer"]);
    expect(members).toContain("trent-engineer/distribution.yaml");
    expect(members).toContain("trent-engineer/SOUL.md");
    expect(members).toContain("trent-engineer/skills/repo-audit/SKILL.md");
    expect(members).not.toContain("trent-engineer/agent.json");
    expect(members).not.toContain("trent-engineer/trent-engineer.tar.gz");
  });

  it("round-trips: fleet import of the export restores the record with its seat block", async () => {
    const out = tmp("hermes-round-trip");
    await exportHermesProfiles({ versions: versions(), target: "engineer", dir: out, profileDir: tmp("profile") });
    const fresh = tmp("fresh");
    const imported = await importAgent({ versions: versions(), dir: out, profile: { agentsDir: path.join(fresh, "agents"), skillsDir: path.join(fresh, "skills") } });
    expect(imported.version.agentId).toBe("engineer");
    const record = JSON.parse(fs.readFileSync(path.join(fresh, "agents", "engineer.json"), "utf8")) as { seat?: { budgetCents: number; toolsets: string[] }; installed_skills: string[] };
    const seat = seatCapability("engineer");
    expect(record.seat).toMatchObject({ budgetCents: seat.budgetCents, toolsets: [...seat.toolsets] });
    expect(record.installed_skills).toEqual(["repo-audit"]);
  });

  it("refuses a target that is neither a pack nor an agent", async () => {
    await expect(exportHermesProfiles({ versions: versions(), target: "no-such-thing", dir: tmp("x"), profileDir: tmp("p") })).rejects.toThrow(/no-such-thing/);
  });
});

describe("exportHermesProfiles for a pack", () => {
  it("writes one profile per seat member, each with the pack's persona in SOUL.md and its own archive", async () => {
    const profileDir = tmp("profile-pack");
    fs.mkdirSync(path.join(profileDir, "brain", "system"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "brain", "system", "persona-executive.md"), "The executive crew keeps the founder's week honest.\n");
    const out = tmp("hermes-pack");
    const result = await exportHermesProfiles({ versions: versions(), target: "executive", dir: out, profileDir });
    expect(result.pack).toBe("executive");
    expect(result.persona).toBe(true);
    expect(result.agents).toEqual(["ceo", "engineer", "growth", "finance"]);
    for (const profile of result.profiles) {
      expect(profile.dir).toBe(path.join(out, profile.agentId));
      const soul = fs.readFileSync(path.join(profile.dir, "SOUL.md"), "utf8");
      expect(soul).toContain("The executive crew keeps the founder's week honest.");
      expect(soul).toContain(`You are the ${profile.agentId} seat.`);
      expect(fs.existsSync(profile.archive)).toBe(true);
      expect(fs.existsSync(path.join(profile.dir, "agent.json"))).toBe(true);
    }
    // finance's manifest has no terminal: Hermes's terminal is disabled for it.
    const finance = parseYaml(fs.readFileSync(path.join(out, "finance", "config.yaml"), "utf8")) as { platform_toolsets: { cli: string[] }; agent: { disabled_toolsets: string[] } };
    expect(finance.platform_toolsets.cli).not.toContain("terminal");
    expect(finance.agent.disabled_toolsets).toContain("terminal");
  });

  it("a pack with no persona file exports without one and skips members that are neither seats nor installed", async () => {
    const out = tmp("hermes-pack-none");
    const result = await exportHermesProfiles({ versions: versions(), target: "eng-trio", dir: out, profileDir: tmp("profile-none") });
    expect(result.persona).toBe(false);
    expect(result.agents).toEqual(["engineer"]);
    expect(result.skipped.map((s) => s.agentId).sort()).toEqual(["eng-ai-engineer", "eng-backend-architect"]);
  });
});
