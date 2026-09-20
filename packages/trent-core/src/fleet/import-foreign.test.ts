/**
 * X6 — `import-foreign.ts` dispatches by the format it detects: a Trent bundle (`agent.json`),
 * a Claude subagent (`.claude/agents/*.md`), a Codex agent (`.codex/agents/*.toml`), a Hermes
 * distribution (`distribution.yaml`, or a `.tar.gz`). A path that is none of them fails typed.
 * Every foreign server entry is normalised to the profile's `mcp_servers` shape, and a literal
 * secret in it is replaced by the `${NAME}` reference the profile stores, never kept.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryImproveStore } from "../improve/memory-store.js";
import type { AgentDefinition } from "../store/StorePort.js";
import { createAgentVersions, type AgentDefinitionSource } from "./AgentVersions.js";
import { detectForeignFormat, importForeignAgent, normaliseMcpEntry, seatPromptOf } from "./import-foreign.js";

const dirs: string[] = [];
const tmp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trent-${label}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function versions() {
  const source: AgentDefinitionSource = {
    async definition(): Promise<AgentDefinition> {
      return { prompt: "unused", model: { provider: "anthropic", model: "claude-sonnet-4-5" }, toolsets: [], skills: [] };
    },
  };
  return createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co", source });
}

describe("detectForeignFormat", () => {
  it("names each layout from what is on disk, and a Trent bundle as trent", () => {
    const claude = tmp("detect-claude");
    fs.mkdirSync(path.join(claude, ".claude", "agents"), { recursive: true });
    fs.writeFileSync(path.join(claude, ".claude", "agents", "x.md"), "---\nname: x\ndescription: X.\n---\nBody.\n");
    expect(detectForeignFormat(claude)).toBe("claude");
    expect(detectForeignFormat(path.join(claude, ".claude", "agents", "x.md"))).toBe("claude");

    const codex = tmp("detect-codex");
    fs.mkdirSync(path.join(codex, ".codex", "agents"), { recursive: true });
    fs.writeFileSync(path.join(codex, ".codex", "agents", "y.toml"), 'name = "y"\n');
    expect(detectForeignFormat(codex)).toBe("codex");
    expect(detectForeignFormat(path.join(codex, ".codex", "agents", "y.toml"))).toBe("codex");

    const hermes = tmp("detect-hermes");
    fs.writeFileSync(path.join(hermes, "distribution.yaml"), "name: z\n");
    expect(detectForeignFormat(hermes)).toBe("hermes");
    fs.writeFileSync(path.join(hermes, "z.tar.gz"), "");
    expect(detectForeignFormat(path.join(hermes, "z.tar.gz"))).toBe("hermes");

    const trent = tmp("detect-trent");
    fs.writeFileSync(path.join(trent, "agent.json"), "{}");
    expect(detectForeignFormat(trent)).toBe("trent");

    expect(detectForeignFormat(tmp("detect-nothing"))).toBeUndefined();
  });

  it("prefers the Trent bundle when a host export sits beside it", () => {
    const both = tmp("detect-both");
    fs.writeFileSync(path.join(both, "agent.json"), "{}");
    fs.mkdirSync(path.join(both, ".claude", "agents"), { recursive: true });
    fs.writeFileSync(path.join(both, ".claude", "agents", "x.md"), "---\nname: x\n---\n");
    expect(detectForeignFormat(both)).toBe("trent");
  });
});

describe("importForeignAgent on an unknown format", () => {
  it("fails typed, naming the path and the four layouts it knows", async () => {
    const nothing = tmp("unknown");
    fs.writeFileSync(path.join(nothing, "notes.txt"), "not an agent");
    await expect(importForeignAgent({ versions: versions(), target: nothing, profile: { agentsDir: tmp("u-a"), skillsDir: tmp("u-s") }, model: { provider: "anthropic", model: "m" }, mcpServers: { has: () => false, set: () => undefined } })).rejects.toMatchObject({
      name: "TrentError",
      operation: "fleet.import.detect",
      target: nothing,
      message: expect.stringMatching(/claude.*codex.*hermes/i),
    });
  });

  it("refuses a --from that the path does not match, typed", async () => {
    const nothing = tmp("mismatch");
    await expect(importForeignAgent({ versions: versions(), target: nothing, format: "codex", profile: { agentsDir: tmp("m-a"), skillsDir: tmp("m-s") }, model: { provider: "anthropic", model: "m" }, mcpServers: { has: () => false, set: () => undefined } })).rejects.toMatchObject({ name: "TrentError", operation: "fleet.import.codex" });
  });
});

describe("normaliseMcpEntry", () => {
  it("reads stdio and http entries into the profile's shape and recognises Trent's own server", () => {
    expect(normaliseMcpEntry("gh", { command: "gh-mcp", args: ["--stdio"] })).toEqual({ entry: { transport: "stdio", command: "gh-mcp", args: ["--stdio"], env: {}, auto_approve: [], enabled: true }, notes: [] });
    expect(normaliseMcpEntry("docs", { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "${DOCS_TOKEN}" } })).toEqual({ entry: { transport: "http", url: "https://docs.example/mcp", headers: { Authorization: "${DOCS_TOKEN}" }, auto_approve: [], enabled: true }, notes: [] });
    expect(normaliseMcpEntry("trent", { command: "trent", args: ["mcp", "serve", "--stdio"] }).entry).toBeUndefined();
    expect(normaliseMcpEntry("trent", { command: "trent", args: ["mcp", "serve", "--stdio"] }).notes.join(" ")).toMatch(/trent mcp serve/);
  });

  it("replaces a literal secret with its reference and says so without the value", () => {
    const out = normaliseMcpEntry("gh", { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_notasecretreally", PATH_EXTRA: "/opt/bin" } });
    expect(out.entry).toMatchObject({ env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", PATH_EXTRA: "/opt/bin" } });
    expect(out.notes.join(" ")).toContain("GITHUB_TOKEN");
    expect(JSON.stringify(out)).not.toContain("notasecretreally");
  });

  it("refuses a name the profile cannot hold, or an entry with neither command nor url, by note", () => {
    expect(normaliseMcpEntry("Bad Name", { command: "x" }).entry).toBeUndefined();
    expect(normaliseMcpEntry("empty", {}).entry).toBeUndefined();
    expect(normaliseMcpEntry("terminal", { command: "x" }).entry).toBeUndefined();
  });
});

describe("seatPromptOf", () => {
  it("returns the seat prompt section of a body the exporter wrote, and the whole body otherwise", () => {
    expect(seatPromptOf("## Persona: Crew\n\nVoice.\n\n## Seat prompt\n\nDo the work.\n\n## What Trent asks before doing\n\nGates.\n\n## Skills\n\n- x\n")).toEqual({ prompt: "Do the work.", exported: true });
    expect(seatPromptOf("Just a prompt.\n")).toEqual({ prompt: "Just a prompt.", exported: false });
  });
});
