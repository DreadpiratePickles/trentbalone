import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildTrentTools } from "../tools/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { IdempotencyManager } from "./IdempotencyManager.js";
import { PolicyDispatcher } from "./policy-dispatch.js";
import { DEFAULT_POLICY_RULES } from "./policy-rules.js";
import { runWithToolCallContext } from "./tool-call-context.js";

function sendAdapter(calls: string[]): TrentToolAdapter {
  return {
    name: "email",
    scopes: ["email", "send_message"],
    availability: "real",
    instructions: "",
    routingText: "",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action) => {
      calls.push(action);
      return { adapter: "email", action, status: "completed", summary: "sent" };
    },
    cleanup: async () => undefined,
  };
}

function workspaceWithSecrets(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-policy-dispatch-"));
  fs.writeFileSync(path.join(root, ".env"), "SECRET_TOKEN=do-not-read\n");
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "config", "credentials.json"), '{"token":"do-not-send"}\n');
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  return root;
}

function build(root: string, policy: PolicyDispatcher) {
  return buildTrentTools(
    { toolsets: ["file_ops"], disabled_toolsets: [] },
    { workspace: root, profileDir: path.join(root, "profile"), backend: "local", autoApproveWrites: true, idempotency: new IdempotencyManager(), policy },
  );
}

const SEND = 'send_message {"to":"someone@example.com","body":"hi"}';

describe("policy rules at the tool dispatch point", () => {
  it("a send after a secret read in the same run is blocked with the rule id and the adapter never executes", async () => {
    const root = workspaceWithSecrets();
    const calls: string[] = [];
    try {
      const policy = new PolicyDispatcher(DEFAULT_POLICY_RULES);
      const { adapters } = build(root, policy);
      const [fileOps] = adapters;
      const [email] = policy.wrap([sendAdapter(calls)]);
      const result = await runWithToolCallContext({ runId: "run_p", stepId: "step_1" }, async () => {
        const read = await fileOps.execute('read_file {"path":"config/credentials.json"}', {});
        expect(read.status).toBe("completed");
        return email.execute(SEND, {});
      });
      expect(result.status).toBe("blocked");
      expect(result.summary).toContain("send-after-secret");
      expect(result.summary).toMatch(/secret/i);
      expect(calls).toEqual([]);
      await Promise.all(adapters.map((adapter) => adapter.cleanup()));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an attempted .env read counts even though file_ops itself refuses it", async () => {
    const root = workspaceWithSecrets();
    const calls: string[] = [];
    try {
      const policy = new PolicyDispatcher(DEFAULT_POLICY_RULES);
      const { adapters } = build(root, policy);
      const [fileOps] = adapters;
      const [email] = policy.wrap([sendAdapter(calls)]);
      const result = await runWithToolCallContext({ runId: "run_q", stepId: "step_1" }, async () => {
        expect((await fileOps.execute('read_file {"path":".env"}', {})).status).toBe("blocked");
        return email.execute(SEND, {});
      });
      expect(result.status).toBe("blocked");
      expect(calls).toEqual([]);
      await Promise.all(adapters.map((adapter) => adapter.cleanup()));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the same send without a prior secret read executes; history is per run", async () => {
    const root = workspaceWithSecrets();
    const calls: string[] = [];
    try {
      const policy = new PolicyDispatcher(DEFAULT_POLICY_RULES);
      const { adapters } = build(root, policy);
      const [fileOps] = adapters;
      const [email] = policy.wrap([sendAdapter(calls)]);
      await runWithToolCallContext({ runId: "run_r", stepId: "step_1" }, () => fileOps.execute('read_file {"path":"config/credentials.json"}', {}));
      const result = await runWithToolCallContext({ runId: "run_s", stepId: "step_1" }, async () => {
        await fileOps.execute('read_file {"path":"README.md"}', {});
        return email.execute(SEND, {});
      });
      expect(result.status).toBe("completed");
      expect(calls).toEqual([SEND]);
      await Promise.all(adapters.map((adapter) => adapter.cleanup()));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("require_approval surfaces through requiresApproval and dryRun as needs_approval naming the rule", async () => {
    const calls: string[] = [];
    const policy = new PolicyDispatcher([{ id: "ask-send", effect: "require_approval", when: "external_send", within: 20, reason: "a human confirms every send" }]);
    const [email] = policy.wrap([sendAdapter(calls)]);
    expect(email.requiresApproval(SEND)).toBe(true);
    const pause = await email.dryRun!(SEND, {});
    expect(pause.status).toBe("needs_approval");
    expect(pause.summary).toContain("ask-send");
    expect(pause.summary).toContain("a human confirms every send");
    expect(calls).toEqual([]);
    // The app calls execute only after the approval is granted; the wrapper lets it through.
    expect((await email.execute(SEND, {})).status).toBe("completed");
    expect(calls).toEqual([SEND]);
  });

  it("a config rule overriding a default id changes the effect at dispatch", async () => {
    const calls: string[] = [];
    const policy = new PolicyDispatcher(DEFAULT_POLICY_RULES, [
      { id: "send-after-secret", effect: "require_approval", when: "external_send", after: "secret_access", within: 20, reason: "ask instead of deny" },
    ]);
    const [email] = policy.wrap([sendAdapter(calls)]);
    // Outside a run the process-wide ring is used.
    policy.remember({ adapter: "file_ops", scopes: ["file_ops"], tool: "read_file", args: { path: ".env" } });
    expect(email.requiresApproval(SEND)).toBe(true);
    expect((await email.dryRun!(SEND, {})).summary).toContain("ask instead of deny");
    expect(calls).toEqual([]);
  });

  it("keeps the adapter's other members intact, including live getters", () => {
    const base = sendAdapter([]);
    let live = ["email"];
    Object.defineProperty(base, "scopes", { get: () => live, enumerable: true });
    const [wrapped] = new PolicyDispatcher(DEFAULT_POLICY_RULES).wrap([base]);
    live = ["email", "send_message"];
    expect(wrapped.scopes).toEqual(["email", "send_message"]);
    expect(wrapped.name).toBe("email");
  });
});
