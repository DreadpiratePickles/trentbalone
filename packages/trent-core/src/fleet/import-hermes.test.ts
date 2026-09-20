/**
 * X6 — `fleet import --from hermes`: a Hermes profile distribution, as a directory or as the
 * `<name>.tar.gz` the exporter (and `hermes profile export`) writes: the manifest, SOUL.md,
 * config.yaml toolsets by the shared names, skills/, mcp.json. The exporter's own output reads
 * back to an equivalent record; a foreign profile's `mcp.json` entry goes through the install-time
 * scan with `--allow-flagged` semantics before it reaches the profile's `mcp_servers`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { McpServerConfig } from "../config/sections/mcp-servers.js";
import { InMemoryImproveStore } from "../improve/memory-store.js";
import type { AgentDefinition } from "../store/StorePort.js";
import { createAgentVersions, type AgentDefinitionSource } from "./AgentVersions.js";
import { exportHermesProfiles, HERMES_TOOLSET_NAMES } from "./export-hermes.js";
import { importForeignAgent, type McpScanOutcome } from "./import-foreign.js";
import { hermesToolsets, readHermesProfile } from "./import-hermes.js";
import { seatCapability } from "./seat-capabilities.js";
import { tarGzDirectory } from "./targz.js";

const dirs: string[] = [];
const tmp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trent-${label}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PROMPT = "You are the engineer seat. Ship small commits.";
const SKILL = "# Repository Audit\n> Map the codebase.\n\nList every package.";

function versions() {
  const source: AgentDefinitionSource = {
    async definition(): Promise<AgentDefinition> {
      return { prompt: PROMPT, model: { provider: "anthropic", model: "claude-sonnet-4-5" }, toolsets: ["file_ops", "terminal"], skills: [{ slug: "repo-audit", content: SKILL }] };
    },
  };
  return createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co", source });
}

const MODEL = { provider: "anthropic", model: "claude-sonnet-4-5" };
const noServers = { has: () => false, set: () => undefined };
/** What a Hermes file can carry of a seat: the toolsets Hermes has a name for (the table says which). */
const carried = (agentId: string) => seatCapability(agentId).toolsets.filter((t) => HERMES_TOOLSET_NAMES[t] !== null).sort();

/** A foreign Hermes profile with one skill and one `mcp.json` server, as a directory. */
function writeForeignProfile(root: string): void {
  fs.writeFileSync(path.join(root, "distribution.yaml"), "name: night-owl\nversion: 1.0.0\ndescription: Watches the logs.\n");
  fs.writeFileSync(path.join(root, "SOUL.md"), "# Night Owl\n\nWatch the logs and say what changed.\n");
  fs.writeFileSync(path.join(root, "config.yaml"), "platform_toolsets:\n  cli:\n    - file\n    - terminal\n    - web\n    - clarify\n    - moonbeam\nagent:\n  disabled_toolsets:\n    - browser\n");
  fs.writeFileSync(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { logs: { type: "stdio", command: "logs-mcp", args: [], env: { LOGS_TOKEN: "${LOGS_TOKEN}" } } } }));
  fs.mkdirSync(path.join(root, "skills", "ops", "log-read"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "ops", "log-read", "SKILL.md"), "---\nname: log-read\ndescription: Read a log.\n---\n# Log read\n\nNewest first.\n");
}

describe("hermesToolsets", () => {
  it("maps the shared names one to one, the four Hermes spellings back, and names the rest", () => {
    expect(hermesToolsets(["file", "terminal", "web", "code_execution", "cronjob", "clarify", "trent", "todo", "session_search", "moonbeam"])).toEqual({
      toolsets: ["file_ops", "terminal", "web", "code", "cron", "human"],
      unmapped: ["moonbeam"],
    });
  });
});

describe("readHermesProfile on the exporter's own output", () => {
  it("reads the seat id from the manifest, the seat prompt, the toolsets by the shared names, the skill and Trent's own server back", async () => {
    const out = tmp("hermes-export");
    await exportHermesProfiles({ versions: versions(), target: "engineer", dir: out, profileDir: tmp("profile"), profile: "default" });
    const agent = readHermesProfile(out);
    expect(agent.format).toBe("hermes");
    expect(agent.agentId).toBe("engineer");
    expect(agent.name).toBe("trent-engineer");
    expect(agent.prompt.trim()).toBe(PROMPT);
    expect([...agent.toolsets].sort()).toEqual(carried("engineer"));
    expect(agent.denied).toEqual([]);
    expect(agent.skills.map((s) => s.slug)).toEqual(["repo-audit"]);
    expect(agent.mcpServers).toEqual([]);
    expect(agent.notCarried.some((line) => /trent mcp serve/.test(line))).toBe(true);
    agent.cleanup();
  });

  it("reads the same profile from the exporter's tarball and cleans its extraction up", async () => {
    const out = tmp("hermes-tar");
    const exported = await exportHermesProfiles({ versions: versions(), target: "engineer", dir: out, profileDir: tmp("profile") });
    const agent = readHermesProfile(exported.profiles[0]!.archive);
    expect(agent.agentId).toBe("engineer");
    expect(agent.prompt.trim()).toBe(PROMPT);
    expect(agent.skills.map((s) => s.slug)).toEqual(["repo-audit"]);
    const skillDir = agent.skills[0]!.dir!;
    expect(fs.existsSync(skillDir)).toBe(true);
    agent.cleanup();
    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it("imports the tarball back to an equivalent candidate", async () => {
    const out = tmp("hermes-round-trip");
    const exported = await exportHermesProfiles({ versions: versions(), target: "engineer", dir: out, profileDir: tmp("profile") });
    const result = await importForeignAgent({ versions: versions(), target: exported.profiles[0]!.archive, format: "hermes", profile: { agentsDir: tmp("h-agents"), skillsDir: tmp("h-skills") }, model: MODEL, mcpServers: noServers });
    expect(result.version.label).toBe("candidate");
    expect(result.version.agentId).toBe("engineer");
    expect(result.version.definition.prompt.trim()).toBe(PROMPT);
    expect([...result.version.toolsets].sort()).toEqual(carried("engineer"));
    expect(result.version.definition.skills.map((s) => s.slug)).toEqual(["repo-audit"]);
  });
});

describe("a foreign Hermes profile", () => {
  it("reads the manifest name, SOUL.md, the toolsets with the unknown one named, the nested skill and mcp.json", () => {
    const root = tmp("hermes-foreign");
    writeForeignProfile(root);
    const agent = readHermesProfile(root);
    expect(agent.agentId).toBe("night-owl");
    expect(agent.description).toBe("Watches the logs.");
    expect(agent.prompt).toContain("Watch the logs and say what changed.");
    expect(agent.toolsets).toEqual(["file_ops", "terminal", "web", "human", "mcp"]);
    expect(agent.denied).toEqual(["browser"]);
    expect(agent.notCarried.find((line) => line.includes("moonbeam"))).toBeDefined();
    expect(agent.skills.map((s) => s.slug)).toEqual(["log-read"]);
    expect(agent.mcpServers).toMatchObject([{ name: "logs", entry: { transport: "stdio", command: "logs-mcp", args: [], env: { LOGS_TOKEN: "${LOGS_TOKEN}" } } }]);
  });

  it("runs the install-time scan over the tarball's mcp.json entry; a finding keeps the server out unless flagged installs are allowed", async () => {
    const root = tmp("hermes-foreign-tar");
    const profileDir = path.join(root, "night-owl");
    fs.mkdirSync(profileDir);
    writeForeignProfile(profileDir);
    const archive = path.join(root, "night-owl.tar.gz");
    fs.writeFileSync(archive, tarGzDirectory(profileDir, { rootName: "night-owl" }));

    const scanned: Array<{ name: string; entry: McpServerConfig }> = [];
    const written = new Map<string, McpServerConfig>();
    const sink = { has: (name: string) => written.has(name), set: (name: string, entry: McpServerConfig) => void written.set(name, entry) };
    const finding = { tool: "tail", categories: ["Prompt injection / jailbreak attempt"] };
    const scanServer = async (name: string, entry: McpServerConfig): Promise<McpScanOutcome> => {
      scanned.push({ name, entry });
      return { scanRan: true, findings: [finding] };
    };

    const refused = await importForeignAgent({ versions: versions(), target: archive, format: "hermes", profile: { agentsDir: tmp("t-agents"), skillsDir: tmp("t-skills") }, model: MODEL, mcpServers: sink, scanServer });
    expect(scanned.map((s) => s.name)).toEqual(["logs"]);
    expect(scanned[0]?.entry).toMatchObject({ transport: "stdio", command: "logs-mcp" });
    expect(written.size).toBe(0);
    expect(refused.mcpServers).toEqual([{ name: "logs", outcome: "refused", scanRan: true, findings: [finding] }]);
    expect(refused.version.toolsets).not.toContain("mcp");

    const allowed = await importForeignAgent({ versions: versions(), target: archive, format: "hermes", profile: { agentsDir: tmp("t2-agents"), skillsDir: tmp("t2-skills") }, model: MODEL, mcpServers: sink, scanServer, allowFlagged: true });
    expect(allowed.mcpServers).toEqual([{ name: "logs", outcome: "added", scanRan: true, findings: [finding] }]);
    expect(written.get("logs")).toMatchObject({ transport: "stdio", command: "logs-mcp", scanRan: true, flagged: [finding] });
    expect(allowed.version.toolsets).toContain("mcp");

    // A server the profile already has is left alone, and said so.
    const again = await importForeignAgent({ versions: versions(), target: archive, format: "hermes", profile: { agentsDir: tmp("t3-agents"), skillsDir: tmp("t3-skills") }, model: MODEL, mcpServers: sink, scanServer });
    expect(again.mcpServers).toEqual([{ name: "logs", outcome: "kept", scanRan: false, findings: [] }]);
  });

  it("refuses a tarball whose one top-level directory holds no manifest, typed, and leaves nothing extracted behind", () => {
    const root = tmp("hermes-bad-tar");
    fs.mkdirSync(path.join(root, "a"));
    fs.writeFileSync(path.join(root, "a", "README.md"), "# not a profile\n");
    const archive = path.join(root, "two.tar.gz");
    fs.writeFileSync(archive, tarGzDirectory(root, { rootName: "two", include: (rel) => rel !== "two.tar.gz" }));
    expect(() => readHermesProfile(archive)).toThrow(expect.objectContaining({ operation: "fleet.import.hermes", message: expect.stringContaining("distribution.yaml") }));
  });
});
