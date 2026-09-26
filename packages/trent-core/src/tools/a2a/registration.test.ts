/**
 * P2-9 RED — where the `a2a` toolset must be registered, what the shipped gate makes of each of its
 * tools, the `a2a.peers` config block, and the build and setup rules:
 *
 *   - the enum, IMPLEMENTED_TOOLSETS, TOOLSET_BY_ADAPTER, the reserved names, the MCP table, the
 *     Hermes export table, the seats (shared: every seat may ask a peer, every send asks a human),
 *     the blank slate (off) and docs/tools.md;
 *   - `a2a_send` is on the class floor and keyed by the idempotency wrapper; `a2a_list`,
 *     `a2a_discover` and `a2a_history` are neither. Without two classifier words the last two
 *     would fall through to the adapter's scope list, find `send` there and be floored: a card
 *     fetch and a local file read asking a human at every level;
 *   - `a2a.peers` holds names and URLs and the NAME of the env var the bearer lives in, never a
 *     value: a `token` key is refused, and `token_env` must be a name `trent config set` routes to
 *     the secrets file;
 *   - no egress proxy and no test transport means skipped, with the reason; quick setup turns the
 *     toolset on only when peers are configured.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ConfigManager } from "../../config/ConfigManager.js";
import { BLANK_SLATE_CONFIG, DEFAULT_CONFIG } from "../../config/defaults.js";
import { TrentConfigSchema } from "../../config/schema.js";
import { ToolsetSchema } from "../../config/sections/tools.js";
import { HERMES_TOOLSET_NAMES } from "../../fleet/export-hermes.js";
import { SEAT_ROLES } from "../../orchestrator/seat-wiring.js";
import { SHARED_SEAT_TOOLSETS, seatCapability } from "../../fleet/seat-capabilities.js";
import { classFloorOf } from "../../governance/autonomy.js";
import { CLASS_FLOOR } from "../../governance/gate-config-schema.js";
import { isSideEffecting } from "../../governance/idempotent-dispatch.js";
import { classifyCall } from "../../governance/policy-rules.js";
import { MCP_TOOLS_BY_TOOLSET } from "../../mcp-server/toolset-tools.js";
import { CollectingOutput } from "../../setup/ports.js";
import { ScriptedPrompts } from "../../setup/ScriptedPrompts.js";
import { SetupWizard } from "../../setup/SetupWizard.js";
import { IMPLEMENTED_TOOLSETS, TOOLSET_BY_ADAPTER, buildTrentTools } from "../index.js";
import { BUILTIN_TOOLS_BY_TOOLSET } from "../tool-names.js";
import { A2A_ADAPTER_NAME, A2A_TOOL_NAMES, A2A_TOOL_SCHEMAS, A2A_WRITE_TOOLS } from "./schemas.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-a2a-reg-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const SCOPES = [A2A_ADAPTER_NAME, ...A2A_TOOL_NAMES];

describe("the a2a toolset is registered everywhere a toolset must be", () => {
  it("enum, builder, adapter map, reserved names, MCP table, Hermes export, seats, blank slate and docs/tools.md", () => {
    expect(A2A_TOOL_NAMES).toEqual(["a2a_list", "a2a_discover", "a2a_send", "a2a_history"]);
    expect(ToolsetSchema.options).toContain("a2a");
    expect(IMPLEMENTED_TOOLSETS).toContain("a2a");
    expect(TOOLSET_BY_ADAPTER[A2A_ADAPTER_NAME]).toBe("a2a");
    expect(BUILTIN_TOOLS_BY_TOOLSET.a2a).toEqual([A2A_ADAPTER_NAME, ...A2A_TOOL_NAMES]);
    expect([...MCP_TOOLS_BY_TOOLSET.a2a]).toEqual([...A2A_TOOL_NAMES]);
    expect("a2a" in HERMES_TOOLSET_NAMES).toBe(true);
    expect(SHARED_SEAT_TOOLSETS).toContain("a2a");
    for (const seat of SEAT_ROLES) expect(seatCapability(seat).toolsets, seat).toContain("a2a");
    expect(BLANK_SLATE_CONFIG.toolsets).not.toContain("a2a");
    expect(BLANK_SLATE_CONFIG.disabled_toolsets).toContain("a2a");
    expect(DEFAULT_CONFIG.toolsets).not.toContain("a2a");
    const doc = fs.readFileSync(path.join(process.cwd(), "docs", "tools.md"), "utf8");
    expect(doc).toContain("`a2a`");
    for (const name of A2A_TOOL_NAMES) expect(doc, name).toContain(`\`${name}\``);
    expect(A2A_TOOL_SCHEMAS.map((schema) => schema.name)).toEqual([...A2A_TOOL_NAMES]);
  });

  it("floors and keys the send and nothing else; the discover is a network read and the history a local read", () => {
    for (const name of A2A_TOOL_NAMES) {
      const floored = classFloorOf({ adapter: A2A_ADAPTER_NAME, scopes: SCOPES, tool: name, args: {} }, CLASS_FLOOR);
      if (A2A_WRITE_TOOLS.has(name)) expect(floored, name).toEqual(["external_send"]);
      else expect(floored, name).toEqual([]);
      expect(isSideEffecting(A2A_ADAPTER_NAME, name), name).toBe(A2A_WRITE_TOOLS.has(name));
    }
    expect(classifyCall({ adapter: A2A_ADAPTER_NAME, scopes: SCOPES, tool: "a2a_discover", args: { url: "https://agent.example.test/" } })).toEqual(["network"]);
    expect(classifyCall({ adapter: A2A_ADAPTER_NAME, scopes: SCOPES, tool: "a2a_history", args: { peer: "hermes" } })).toEqual(["read_only"]);
    expect(classifyCall({ adapter: A2A_ADAPTER_NAME, scopes: SCOPES, tool: "a2a_list", args: {} })).toEqual(["read_only"]);
  });

  it("is skipped with a reason when the egress proxy is not running and no test transport is given", () => {
    const profileDir = path.join(root, "profile");
    fs.mkdirSync(profileDir, { recursive: true });
    const built = buildTrentTools({ toolsets: ["a2a"], disabled_toolsets: [] }, { workspace: root, profileDir, backend: "local", home: root });
    expect(built.adapters.map((adapter) => adapter.name)).not.toContain(A2A_ADAPTER_NAME);
    expect(built.skipped).toEqual([{ toolset: "a2a", reason: expect.stringMatching(/egress proxy/) }]);
  });
});

describe("the a2a.peers config block", () => {
  const parse = (a2a: unknown) => TrentConfigSchema.safeParse({ a2a });

  it("defaults to no peers and keeps a name, a url and a token NAME", () => {
    expect(TrentConfigSchema.parse({}).a2a).toEqual({ peers: [] });
    const parsed = parse({ peers: [{ name: "hermes", url: "https://hermes.example.test/", token_env: "HERMES_A2A_TOKEN" }, { name: "local-trent", url: "http://127.0.0.1:7899" }] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.a2a.peers.map((peer) => peer.name)).toEqual(["hermes", "local-trent"]);
  });

  it("refuses a token value, a token_env that is not a secret-shaped env name, a non-http url and a duplicate name", () => {
    expect(parse({ peers: [{ name: "hermes", url: "https://h.example.test/", token: "a-value-in-config" }] }).success).toBe(false);
    expect(parse({ peers: [{ name: "hermes", url: "https://h.example.test/", token_env: "hermes_token" }] }).success).toBe(false);
    expect(parse({ peers: [{ name: "hermes", url: "https://h.example.test/", token_env: "HERMES_PEER" }] }).success).toBe(false);
    expect(parse({ peers: [{ name: "hermes", url: "file:///etc/passwd" }] }).success).toBe(false);
    expect(parse({ peers: [{ name: "Hermes Agent", url: "https://h.example.test/" }] }).success).toBe(false);
    expect(parse({ peers: [{ name: "hermes", url: "https://a.example.test/" }, { name: "hermes", url: "https://b.example.test/" }] }).success).toBe(false);
  });
});

describe("quick setup and the a2a toolset", () => {
  function wizard(configManager: ConfigManager, output: CollectingOutput): SetupWizard {
    return new SetupWizard({ configManager, prompts: new ScriptedPrompts({ confirm: true }), output, env: { ANTHROPIC_API_KEY: "sk-ant-test-fixture" }, mediaBackendPresent: async () => true, socialProviderConnected: () => true, businessProviderConnected: () => true });
  }
  const onDisk = (manager: ConfigManager) => parseYaml(fs.readFileSync(manager.getConfigPath(), "utf8")) as { toolsets: string[]; disabled_toolsets: string[] };

  it("leaves a2a off, explicitly and with the reason, when no peer is configured", async () => {
    const manager = new ConfigManager({ baseDir: root });
    const output = new CollectingOutput();
    expect((await wizard(manager, output).run({ mode: "quick" })).success).toBe(true);
    expect(onDisk(manager).toolsets).not.toContain("a2a");
    expect(onDisk(manager).disabled_toolsets).toContain("a2a");
    expect(output.lines.join("\n")).toMatch(/a2a is off because no A2A peer is configured/);
  });

  it("turns a2a on when a2a.peers names at least one peer", async () => {
    const manager = new ConfigManager({ baseDir: root });
    manager.saveConfig({ ...manager.loadConfig(), a2a: { peers: [{ name: "hermes", url: "https://hermes.example.test/" }] } });
    expect((await wizard(manager, new CollectingOutput()).run({ mode: "quick" })).success).toBe(true);
    expect(onDisk(manager).toolsets).toContain("a2a");
    expect(onDisk(manager).disabled_toolsets).not.toContain("a2a");
  });
});
