/**
 * A2.2 — the seam itself. `buildTrentTools` is the single place every toolset adapter is built and
 * wrapped, so proving the wrapper is applied THERE is what makes the floor unavoidable; proving it
 * on a hand-made adapter (`governance/autonomy-dispatch.test.ts`) only proves the wrapper works.
 *
 * The terminal adapter is built on the `local` backend here. Nothing in these tests is allowed to
 * reach it: each asserts a refusal, so a regression that let the command through would try to run
 * `rm -rf /` and the assertion on `blocked` is what stops that being silent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { buildTrentTools } from "./index.js";
import { hookSpecHash, writeConsent } from "../hooks/consent.js";
import { IdempotencyManager } from "../governance/IdempotencyManager.js";

let home: string;
let profileDir: string;
let workspace: string;
let outFile: string;

const BLOCK_FIXTURE = `let d = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => {
  require("node:fs").appendFileSync(process.argv[2], d + "\\n");
  process.stderr.write("hook says: no terminal in this repository\\n");
  process.exit(1);
});
`;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-wiring-home-"));
  profileDir = path.join(home, ".trent", "default");
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-wiring-work-"));
  fs.mkdirSync(profileDir, { recursive: true });
  outFile = path.join(home, "seen.ndjson");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function build(config: Record<string, unknown>) {
  return buildTrentTools(
    { toolsets: ["terminal", "file_ops"], disabled_toolsets: [], ...config },
    { workspace, profileDir, backend: "local", home, idempotency: new IdempotencyManager({ dir: profileDir }) },
  );
}

function adapterNamed(name: string, config: Record<string, unknown>) {
  const found = build(config).adapters.find((adapter) => adapter.name === name);
  if (!found) throw new Error(`the ${name} adapter was not built`);
  return found;
}

describe("buildTrentTools applies the autonomy floor to every adapter it builds", () => {
  it("refuses a hardline command at autonomy: never", async () => {
    const terminal = adapterNamed("terminal", { autonomy: "never" });
    const result = await terminal.execute('terminal {"command":"rm -rf /"}', {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("recursive-delete-of-root-home-or-profile");
  });

  it("refuses a denied glob at autonomy: never", async () => {
    const terminal = adapterNamed("terminal", { autonomy: "never", approvals: { deny: ["*terraform destroy*"] } });
    const result = await terminal.execute('terminal {"command":"terraform destroy -auto-approve"}', {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("*terraform destroy*");
  });

  it("refuses a read of the profile's own .env through file_ops, whatever the level", async () => {
    const fileOps = adapterNamed("file_ops", { autonomy: "never" });
    const result = await fileOps.execute(`read_file ${JSON.stringify({ path: path.join(profileDir, ".env") })}`, {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("read-trent-env-or-ssh-keys");
  });

  it("defaults to today's behaviour when the config says nothing: a write asks, a read does not", () => {
    const fileOps = adapterNamed("file_ops", {});
    expect(fileOps.requiresApproval('read_file {"path":"README.md"}')).toBe(false);
    expect(fileOps.requiresApproval('write_file {"path":"a.txt","content":"x"}')).toBe(true);
  });

  it("asks for a write AND a pure-read-free call at ask_always, and not for a read", () => {
    const fileOps = adapterNamed("file_ops", { autonomy: "ask_always" });
    expect(fileOps.requiresApproval('write_file {"path":"a.txt","content":"x"}')).toBe(true);
    expect(fileOps.requiresApproval('read_file {"path":"README.md"}')).toBe(false);
    const terminal = adapterNamed("terminal", { autonomy: "ask_always" });
    expect(terminal.requiresApproval('terminal {"command":"ls -la"}')).toBe(true);
  });

  it("runs a consented pre-tool hook, which can block the call", async () => {
    const fixture = path.join(home, "block.cjs");
    fs.writeFileSync(fixture, BLOCK_FIXTURE);
    const spec = { command: [process.execPath, fixture, outFile] };
    writeConsent(profileDir, [hookSpecHash("pre_tool_call", spec)]);
    const terminal = adapterNamed("terminal", { autonomy: "never", hooks: { pre_tool_call: [spec], post_tool_call: [], session_start: [], session_stop: [] } });
    const result = await terminal.execute('terminal {"command":"echo hello"}', {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("no terminal in this repository");
  });

  it("never runs an unconsented hook, and the build reports it once", async () => {
    const fixture = path.join(home, "block.cjs");
    fs.writeFileSync(fixture, BLOCK_FIXTURE);
    const spec = { command: [process.execPath, fixture, outFile] };
    const built = build({ autonomy: "never", hooks: { pre_tool_call: [spec], post_tool_call: [], session_start: [], session_stop: [] } });
    const terminal = built.adapters.find((adapter) => adapter.name === "terminal")!;
    const result = await terminal.execute('terminal {"command":"printf x"}', {});
    expect(result.status).not.toBe("blocked");
    expect(fs.existsSync(outFile)).toBe(false);
    expect(built.hookNotices).toHaveLength(1);
    expect(built.hookNotices[0]).toContain("consent");
    for (const adapter of built.adapters) await adapter.cleanup();
  });
});
