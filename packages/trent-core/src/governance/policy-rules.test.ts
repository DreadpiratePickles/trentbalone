import { describe, it, expect } from "vitest";
import {
  classifyCall,
  DEFAULT_POLICY_RULES,
  mergeRules,
  PolicyEvaluator,
  PolicyRuleSchema,
  type PolicyCall,
  type PolicyClass,
} from "./policy-rules.js";

function call(tool: string, ...classes: PolicyClass[]): PolicyCall {
  return { tool, classes, at: 0 };
}

const evaluator = new PolicyEvaluator(DEFAULT_POLICY_RULES);

describe("policy rule schema", () => {
  it("rejects an unknown class and a missing reason, defaults within to 20", () => {
    expect(PolicyRuleSchema.safeParse({ id: "x", effect: "deny", when: "teleport", reason: "no" }).success).toBe(false);
    expect(PolicyRuleSchema.safeParse({ id: "x", effect: "deny", when: "external_send" }).success).toBe(false);
    expect(PolicyRuleSchema.safeParse({ id: "x", effect: "block", when: "external_send", reason: "no" }).success).toBe(false);
    const parsed = PolicyRuleSchema.parse({ id: "x", effect: "deny", when: "external_send", after: "secret_access", reason: "no" });
    expect(parsed.within).toBe(20);
  });

  it("ships default rules with unique ids that all parse", () => {
    const ids = DEFAULT_POLICY_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const rule of DEFAULT_POLICY_RULES) expect(PolicyRuleSchema.safeParse(rule).success, rule.id).toBe(true);
  });

  it("a config rule with a default's id overrides it in place; a new id appends", () => {
    const merged = mergeRules(DEFAULT_POLICY_RULES, [
      { id: "send-after-secret", effect: "require_approval", when: "external_send", after: "secret_access", within: 5, reason: "ask first" },
      { id: "custom-no-deploy", effect: "deny", when: "deploy", within: 20, reason: "never from a seat" },
    ]);
    expect(merged.filter((rule) => rule.id === "send-after-secret")).toHaveLength(1);
    expect(merged.find((rule) => rule.id === "send-after-secret")?.effect).toBe("require_approval");
    expect(merged.at(-1)?.id).toBe("custom-no-deploy");
    expect(merged).toHaveLength(DEFAULT_POLICY_RULES.length + 1);
  });
});

describe("policy evaluator over a synthetic history", () => {
  it("denies an external send after a secret read, naming the rule", () => {
    const history = [call("read_file", "read_only", "secret_access"), call("search_files", "read_only")];
    const decision = evaluator.evaluate(["external_send"], history);
    expect(decision?.effect).toBe("deny");
    expect(decision?.rule.id).toBe("send-after-secret");
  });

  it("allows the same send when no secret was read", () => {
    const history = [call("read_file", "read_only"), call("search_files", "read_only")];
    expect(evaluator.evaluate(["external_send"], history)).toBeUndefined();
  });

  it("only looks back `within` calls: the boundary entry counts, one beyond it does not", () => {
    const rules = new PolicyEvaluator([{ id: "r", effect: "deny", when: "external_send", after: "secret_access", within: 3, reason: "test" }]);
    const secret = call("read_file", "secret_access");
    const noise = call("search_files", "read_only");
    expect(rules.evaluate(["external_send"], [secret, noise, noise])?.rule.id).toBe("r");
    expect(rules.evaluate(["external_send"], [secret, noise, noise, noise])).toBeUndefined();
  });

  it("a rule without `after` matches on the current call alone, and deny beats require_approval", () => {
    const rules = new PolicyEvaluator([
      { id: "ask", effect: "require_approval", when: "money_moving", within: 20, reason: "money" },
      { id: "no", effect: "deny", when: "money_moving", after: "network", within: 20, reason: "money after web" },
    ]);
    expect(rules.evaluate(["money_moving"], [])?.rule.id).toBe("ask");
    expect(rules.evaluate(["money_moving"], [call("web_search", "network")])?.rule.id).toBe("no");
  });

  it("ships the documented defaults: money needs approval, destructive after network needs approval, secret writes are denied", () => {
    expect(evaluator.evaluate(["money_moving"], [])?.effect).toBe("require_approval");
    expect(evaluator.evaluate(["execute", "destructive"], [call("web_extract", "network")])?.effect).toBe("require_approval");
    expect(evaluator.evaluate(["execute", "destructive"], [])).toBeUndefined();
    expect(evaluator.evaluate(["write", "secret_access"], [])?.effect).toBe("deny");
    expect(evaluator.evaluate(["execute"], [call("web_extract", "network")])?.effect).toBe("require_approval");
  });
});

describe("classifyCall derives classes from the scope vocabulary and the arguments", () => {
  const fileOps = { adapter: "file_ops", scopes: ["file_ops", "read_file", "write_file", "patch", "search_files"] };
  it("reads are read_only; a secret path adds secret_access", () => {
    expect(classifyCall({ ...fileOps, tool: "read_file", args: { path: "src/index.ts" } })).toEqual(["read_only"]);
    expect(classifyCall({ ...fileOps, tool: "read_file", args: { path: ".env" } })).toEqual(["read_only", "secret_access"]);
    expect(classifyCall({ ...fileOps, tool: "read_file", args: { path: "keys/id_rsa" } })).toContain("secret_access");
    expect(classifyCall({ ...fileOps, tool: "write_file", args: { path: "config/credentials.json", content: "x" } })).toEqual(["write", "secret_access"]);
  });

  it("terminal is execute; a destructive command adds destructive", () => {
    const terminal = { adapter: "terminal", scopes: ["terminal", "process_manage"] };
    expect(classifyCall({ ...terminal, tool: "terminal", args: { command: "ls -la" } })).toEqual(["execute"]);
    expect(classifyCall({ ...terminal, tool: "terminal", args: { command: "rm -rf build" } })).toEqual(["execute", "destructive"]);
    expect(classifyCall({ ...terminal, tool: "terminal", args: { command: "git push --force origin main" } })).toContain("destructive");
    expect(classifyCall({ ...terminal, tool: "", args: {} })).toEqual(["execute"]);
  });

  it("send, network, money and deploy names map to the MCP class vocabulary", () => {
    expect(classifyCall({ adapter: "email", scopes: ["email", "send_message"], tool: "send_message", args: { to: "a@b.c" } })).toEqual(["external_send"]);
    expect(classifyCall({ adapter: "web", scopes: ["web", "web_search"], tool: "web_search", args: { query: "x" } })).toEqual(["network"]);
    expect(classifyCall({ adapter: "mcp", scopes: ["mcp"], tool: "stripe__create_refund", args: { amount: 1 } })).toContain("money_moving");
    expect(classifyCall({ adapter: "mcp", scopes: ["mcp"], tool: "vercel__deploy_project", args: {} })).toContain("deploy");
    expect(classifyCall({ adapter: "mcp", scopes: ["mcp"], tool: "db__drop_table", args: {} })).toContain("destructive");
  });
});
