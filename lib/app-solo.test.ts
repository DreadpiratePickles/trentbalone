import { describe, expect, it } from "vitest";
import { buildAppSoloObjective, describeChunk, getAppSoloAgents } from "@/lib/app-solo";

describe("describeChunk — App Solo run trace", () => {
  it("summarises each agent chunk type into a trace line", () => {
    expect(describeChunk({ type: "status", phase: "scaffolding", detail: "starter template" })).toBe("scaffolding: starter template");
    expect(describeChunk({ type: "plan", steps: [{}, {}] as never })).toBe("plan ready — 2 steps");
    expect(describeChunk({ type: "file", path: "src/App.tsx", action: "create", bytes: 812 })).toBe("create src/App.tsx (812b)");
    expect(describeChunk({ type: "command", command: "npm install", exitCode: 0, output: "" })).toBe("$ npm install → exit 0");
    expect(describeChunk({ type: "test", passed: 3, failed: 0, healed: false })).toBe("tests: 3 passed, 0 failed");
    expect(describeChunk({ type: "preview", url: "http://localhost:5180" })).toBe("preview ready: http://localhost:5180");
    expect(describeChunk({ type: "done", messageId: "m1" })).toBe("run complete");
  });

  it("reports verify verdicts honestly", () => {
    const line = describeChunk({
      type: "verify",
      passed: false,
      checks: [{ name: "renders", status: "fail", detail: "blank" }],
    });
    expect(line).toBe("verify failed — renders:fail");
  });

  it("omits raw prose tokens from the trace", () => {
    expect(describeChunk({ type: "content", content: "thinking..." })).toBeNull();
  });
});

describe("app-solo registry", () => {
  it("exposes all nine runtime agents", () => {
    const agents = getAppSoloAgents();

    expect(agents.map((agent) => agent.role)).toEqual([
      "ceo",
      "engineer",
      "growth",
      "content",
      "support",
      "finance",
      "analyst",
      "escalation",
      "sales",
    ]);
    expect(agents.map((agent) => agent.label)).toEqual([
      "CEO",
      "Engineer",
      "Growth / Marketing",
      "Design / Content",
      "Support / Ops",
      "Finance",
      "Research / Analyst",
      "Critic / Escalation / Auditor",
      "Sales",
    ]);
  });

  it("maps sandbox apps to only the agents that own them", () => {
    const agents = getAppSoloAgents();
    const growth = agents.find((agent) => agent.role === "growth");
    const finance = agents.find((agent) => agent.role === "finance");
    const engineer = agents.find((agent) => agent.role === "engineer");

    expect(growth?.apps.map((app) => app.name)).toEqual(["Steel Browser", "HyperFrames", "Open Generative AI"]);
    expect(finance?.apps.map((app) => app.name)).toEqual(["Steel Browser", "Fincept Terminal", "Ghostfolio"]);
    expect(engineer?.apps.map((app) => app.name)).toEqual(["Steel Browser"]);
  });

  it("builds a workbench objective with app-solo context and approval gates", () => {
    const finance = getAppSoloAgents().find((agent) => agent.role === "finance");
    const fincept = finance?.apps.find((app) => app.name === "Fincept Terminal");
    const ghostfolio = finance?.apps.find((app) => app.name === "Ghostfolio");

    const objective = buildAppSoloObjective(finance!, fincept!, "Review NVDA concentration risk.");

    expect(objective).toContain("[app-solo] Finance / Fincept Terminal");
    expect(objective).toContain("Review NVDA concentration risk.");
    expect(objective).toContain("fincept.live_trade");
    expect(objective).toContain("App scopes: fincept:");
    expect(objective).toContain("Verification required:");
    expect(objective).toContain("Call out not-done work");
    expect(ghostfolio?.scopes).toEqual(expect.arrayContaining(["ghostfolio:portfolio_overview"]));
  });
});
