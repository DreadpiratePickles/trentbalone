/**
 * A2.2 — the seam. `tools/index.ts` wraps every adapter with this before the policy and
 * idempotency wrappers, so a refusal lands whatever the seat, the level, or an approval already
 * granted for the loop. The tests drive real adapters through the wrapper, not the pure helpers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { autonomyAdapters } from "./autonomy-dispatch.js";
import { record } from "../tools/action.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { createToolHookRunner } from "../hooks/runner.js";
import { hookSpecHash, writeConsent } from "../hooks/consent.js";
import type { HooksConfig } from "../hooks/types.js";

let home: string;
let profileDir: string;
let dir: string;
let outFile: string;

const BLOCK_FIXTURE = `let d = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => {
  require("node:fs").appendFileSync(process.argv[2], d + "\\n");
  process.stderr.write("hook says: this repository forbids terminal\\n");
  process.exit(1);
});
`;

/** Records every action that reached `execute`, so "was it refused" is a fact, not an inference. */
function fakeAdapter(name: string, asks: (action: string) => boolean, executed: string[]): TrentToolAdapter {
  return {
    name,
    scopes: [name],
    availability: "real",
    instructions: "",
    routingText: "",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: asks,
    async execute(action: string): Promise<ToolCallRecord> {
      executed.push(action);
      return record(name, action, "completed", "ran");
    },
    async cleanup() {
      /* nothing to release */
    },
  };
}

function emptyHooks(): HooksConfig {
  return { pre_tool_call: [], post_tool_call: [], session_start: [], session_stop: [] };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-autonomy-home-"));
  profileDir = path.join(home, ".trent", "default");
  fs.mkdirSync(profileDir, { recursive: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-autonomy-fix-"));
  outFile = path.join(dir, "seen.ndjson");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

function wrap(adapter: TrentToolAdapter, over: Partial<Parameters<typeof autonomyAdapters>[1]> = {}): TrentToolAdapter {
  return autonomyAdapters([adapter], { level: "ask_dangerous", deny: [], hardline: { home, profileDir }, ...over })[0]!;
}

describe("autonomy: never still refuses what the floor refuses", () => {
  it("refuses a hardline command, naming the rule, and the adapter never sees it", async () => {
    const executed: string[] = [];
    const wrapped = wrap(fakeAdapter("terminal", () => false, executed), { level: "never" });
    const result = await wrapped.execute('terminal {"command":"rm -rf /"}', {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("recursive-delete-of-root-home-or-profile");
    expect(executed).toEqual([]);
  });

  it("refuses a denied glob, naming the glob, and the adapter never sees it", async () => {
    const executed: string[] = [];
    const wrapped = wrap(fakeAdapter("terminal", () => false, executed), { level: "never", deny: ["*terraform destroy*"] });
    const result = await wrapped.execute('terminal {"command":"terraform destroy -auto-approve"}', {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("*terraform destroy*");
    expect(executed).toEqual([]);
  });

  it("refuses a denied path as well as a denied command", async () => {
    const executed: string[] = [];
    const wrapped = wrap(fakeAdapter("file_ops", () => false, executed), { level: "never", deny: ["*/prod-secrets/*"] });
    const result = await wrapped.execute('write_file {"path":"/srv/prod-secrets/db.yaml","content":"x"}', {});
    expect(result.status).toBe("blocked");
    expect(executed).toEqual([]);
  });

  it("still auto-approves an ordinary dangerous-but-recoverable call", async () => {
    const executed: string[] = [];
    const wrapped = wrap(fakeAdapter("terminal", () => true, executed), { level: "never" });
    expect(wrapped.requiresApproval('terminal {"command":"rm -rf build"}')).toBe(false);
    expect((await wrapped.execute('terminal {"command":"rm -rf build"}', {})).status).toBe("completed");
    expect(executed).toHaveLength(1);
  });
});

describe("ask_dangerous — the default", () => {
  it("auto-approves a read tool", () => {
    const wrapped = wrap(fakeAdapter("file_ops", () => false, []), { level: "ask_dangerous" });
    expect(wrapped.requiresApproval('read_file {"path":"README.md"}')).toBe(false);
  });

  it("asks for a write, because the file_ops floor asks for it", () => {
    const wrapped = wrap(fakeAdapter("file_ops", (action) => action.startsWith("write_file"), []), { level: "ask_dangerous" });
    expect(wrapped.requiresApproval('write_file {"path":"a.txt","content":"x"}')).toBe(true);
  });
});

describe("ask_always", () => {
  it("asks for a write and for a web fetch, and still lets a read through", () => {
    const wrapped = wrap(fakeAdapter("file_ops", () => false, []), { level: "ask_always" });
    expect(wrapped.requiresApproval('write_file {"path":"a.txt","content":"x"}')).toBe(true);
    expect(wrapped.requiresApproval('read_file {"path":"README.md"}')).toBe(false);

    const web = wrap(fakeAdapter("web", () => false, []), { level: "ask_always" });
    expect(web.requiresApproval('web_search {"query":"trent fleet"}')).toBe(true);
  });

  it("explains itself in the dry run, so the approval card says why it is being asked", async () => {
    const wrapped = wrap(fakeAdapter("file_ops", () => false, []), { level: "ask_always" });
    const dry = await wrapped.dryRun!('write_file {"path":"a.txt","content":"x"}', {});
    expect(dry.status).toBe("needs_approval");
    expect(dry.summary).toContain("ask_always");
  });
});

describe("hooks at the seam", () => {
  it("lets a pre hook block the call, and the reason carries the hook's stderr", async () => {
    const fixture = path.join(dir, "block.cjs");
    fs.writeFileSync(fixture, BLOCK_FIXTURE);
    const hooks: HooksConfig = { ...emptyHooks(), pre_tool_call: [{ command: [process.execPath, fixture, outFile] }] };
    writeConsent(profileDir, [hookSpecHash("pre_tool_call", hooks.pre_tool_call[0]!)]);
    const executed: string[] = [];
    const wrapped = wrap(fakeAdapter("terminal", () => false, executed), {
      level: "never",
      hooks: createToolHookRunner({ profileDir, hooks }),
    });
    const result = await wrapped.execute('terminal {"command":"ls"}', {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("this repository forbids terminal");
    expect(executed).toEqual([]);
  });

  it("runs the post hook with the adapter's result and returns that result unchanged", async () => {
    const fixture = path.join(dir, "post.cjs");
    fs.writeFileSync(fixture, BLOCK_FIXTURE);
    const hooks: HooksConfig = { ...emptyHooks(), post_tool_call: [{ command: [process.execPath, fixture, outFile] }] };
    writeConsent(profileDir, [hookSpecHash("post_tool_call", hooks.post_tool_call[0]!)]);
    const executed: string[] = [];
    const wrapped = wrap(fakeAdapter("terminal", () => false, executed), {
      level: "never",
      hooks: createToolHookRunner({ profileDir, hooks }),
    });
    const result = await wrapped.execute('terminal {"command":"ls"}', {});
    expect(result.status).toBe("completed");
    expect(executed).toHaveLength(1);
    const payload = JSON.parse(fs.readFileSync(outFile, "utf8").trim()) as { hook: string; result?: { status: string } };
    expect(payload.hook).toBe("post_tool_call");
    expect(payload.result?.status).toBe("completed");
  });

  it("never runs a hook the pre-flight refused, so a hardline command reaches no hook either", async () => {
    const fixture = path.join(dir, "block2.cjs");
    fs.writeFileSync(fixture, BLOCK_FIXTURE);
    const hooks: HooksConfig = { ...emptyHooks(), pre_tool_call: [{ command: [process.execPath, fixture, outFile] }] };
    writeConsent(profileDir, [hookSpecHash("pre_tool_call", hooks.pre_tool_call[0]!)]);
    const wrapped = wrap(fakeAdapter("terminal", () => false, []), {
      level: "never",
      hooks: createToolHookRunner({ profileDir, hooks }),
    });
    await wrapped.execute('terminal {"command":"rm -rf /"}', {});
    expect(fs.existsSync(outFile)).toBe(false);
  });
});
