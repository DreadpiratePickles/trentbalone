import { describe, it, expect } from "vitest";
import { SLASH_COMMANDS, type SlashCommandContext } from "./index.js";
import { isTrentError } from "@trent/core";
import {
  ConfigManager,
  FleetManager,
  SkillsHub,
  PersonalityManager,
  SessionManager,
  DoctorRunner,
} from "@trent/core";

describe("Slash Commands Suite", () => {
  const configManager = new ConfigManager({ profile: "test-slash" });
  const fleetManager = new FleetManager(configManager);
  const skillsHub = new SkillsHub(configManager);
  const personalityManager = new PersonalityManager(configManager);
  const sessionManager = new SessionManager(configManager);
  const doctorRunner = new DoctorRunner(configManager);

  const ctx: SlashCommandContext = {
    configManager,
    fleetManager,
    skillsHub,
    personalityManager,
    sessionManager,
    doctorRunner,
  };

  it("executes /help and lists all registered commands", async () => {
    const out = await SLASH_COMMANDS["help"].execute([], ctx);
    expect(out).toContain("Available Slash Commands:");
    expect(out).toContain("/fleet");
    expect(out).toContain("/mcp");
    expect(out).toContain("/approvals");
    expect(out).toContain("/wiki");
    expect(out).toContain("/workbench");
    expect(out).toContain("/marketplace");
    expect(out).toContain("/traces");
  });

  it("/voice rejects with a TrentError rather than pretending to toggle a feature", async () => {
    await expect(SLASH_COMMANDS["voice"].execute(["on"], ctx)).rejects.toSatisfy(
      (err: unknown) => isTrentError(err) && err.message.includes("not available in this release"),
    );
  });

  it("executes /mcp to view connectors and policies", async () => {
    const out = await SLASH_COMMANDS["mcp"].execute([], ctx);
    expect(out).toContain("Model Context Protocol (MCP) Connectors:");
    expect(out).toContain("github");
    expect(out).toContain("postgres");
  });

  it("executes /approvals to inspect approval queue", async () => {
    const out = await SLASH_COMMANDS["approvals"].execute([], ctx);
    expect(out).toContain("pending approvals");
  });

  it("executes /wiki to query knowledge base", async () => {
    const out = await SLASH_COMMANDS["wiki"].execute(["query", "architecture"], ctx);
    expect(out).toContain("Knowledge search results");
    expect(out).toContain("Autonomous AI cofounder");
  });

  it("executes /workbench to inspect sandbox runtime", async () => {
    const out = await SLASH_COMMANDS["workbench"].execute([], ctx);
    expect(out).toContain("Workbench Sandbox Runtime:");
    expect(out).toContain("Backend:");
  });

  it("executes /marketplace to view featured specialist packs", async () => {
    const out = await SLASH_COMMANDS["marketplace"].execute([], ctx);
    expect(out).toContain("Agent Marketplace");
    expect(out).toContain("Engineering Trio");
  });

  it("executes /traces to inspect recent agent turns", async () => {
    const out = await SLASH_COMMANDS["traces"].execute([], ctx);
    expect(out).toContain("Recent Agent Execution Traces:");
    expect(out).toContain("OpenTelemetry");
  });
});
