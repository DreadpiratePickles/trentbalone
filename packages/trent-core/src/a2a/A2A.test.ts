import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateAgentCard,
  verifyAgentCardSignature,
  A2AServer,
  type AgentCard,
} from "./index.js";

describe("A2A Protocol", () => {
  const secret = "test-a2a-secret-key-12345";

  it("generates a valid Signed Agent Card with cryptographic signature", () => {
    const card = generateAgentCard(
      {
        id: "eng-ai-engineer",
        name: "AI Systems Engineer",
        description: "Specialist in fine-tuning, evals, and agent architectures.",
        category: "engineering",
        capabilities: ["prompt-eval", "architecture-review"],
        endpoint: "http://localhost:7895/a2a",
      },
      secret
    );

    expect(card.id).toBe("eng-ai-engineer");
    expect(card.capabilities).toContain("prompt-eval");
    expect(card.signature).toBeDefined();
    expect(typeof card.signature).toBe("string");
    expect(card.signature!.length).toBe(64); // SHA-256 hex string
  });

  it("verifies valid agent card signatures and rejects tampered cards", () => {
    const card = generateAgentCard(
      {
        id: "ceo",
        name: "Trent CEO",
        description: "Chief Executive cofounder",
        category: "executive",
        capabilities: ["strategic-planning", "milestone-review"],
        endpoint: "http://localhost:7895/a2a",
      },
      secret
    );

    expect(verifyAgentCardSignature(card, secret)).toBe(true);

    // Tamper with description
    const tampered: AgentCard = {
      ...card,
      description: "Malicious modified description",
    };
    expect(verifyAgentCardSignature(tampered, secret)).toBe(false);
  });

  it("starts A2A server and handles task delegation requests", async () => {
    const server = new A2AServer({ port: 7895, secret });
    await server.start();
    expect(server.isRunning()).toBe(true);

    // 1. Fetch Agent Card
    const cardRes = await fetch("http://127.0.0.1:7895/a2a/card/engineer");
    const cardData = (await cardRes.json()) as any;
    expect(cardData.id).toBe("engineer");
    expect(cardData.signature).toBeDefined();

    // 2. Submit A2A Delegation Task
    const taskRes = await fetch("http://127.0.0.1:7895/a2a/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "task-001",
        originAgent: "remote-partner-agent",
        targetAgent: "engineer",
        taskType: "architecture-review",
        parameters: { repo: "acme/backend" },
      }),
    });
    const taskResult = (await taskRes.json()) as any;
    expect(taskResult.status).toBe("completed");
    expect(taskResult.result.agent).toBe("engineer");
    expect(taskResult.result.summary).toBeDefined();

    await server.stop();
    expect(server.isRunning()).toBe(false);
  });
});
