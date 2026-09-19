/**
 * A2.2 — running a hook. Every hook here is a real spawned process reading a real JSON document
 * on stdin: a hook proved with a mocked child process proves nothing about the seam that matters
 * (argv, stdin, exit code, stderr, timeout).
 *
 * Hooks are spawned with `shell: false` and an argv array, so nothing from a tool argument is
 * ever parsed by a shell. The fixtures below are node scripts taking their output path as argv.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createToolHookRunner, runHook, runSessionHooks } from "./runner.js";
import { toolPayload } from "./payload.js";
import { hookSpecHash, writeConsent } from "./consent.js";
import type { HookSpec, HooksConfig, HookToolCall } from "./types.js";

/** A shape `redactTranscript` recognises, so the assertion is about the redactor, not about luck. */
const FIXTURE_SECRET = "sk-livefixture1234567890abcdefgh";

let dir: string;
let profileDir: string;
let outFile: string;

const RECORD_FIXTURE = `let d = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => { require("node:fs").appendFileSync(process.argv[2], d + "\\n"); process.exit(0); });
`;

const BLOCK_FIXTURE = `let d = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => {
  require("node:fs").appendFileSync(process.argv[2], d + "\\n");
  process.stderr.write("line one of the hook complaint\\n");
  process.stderr.write("policy: this workspace forbids that tool\\n");
  process.exit(1);
});
`;

const HANG_FIXTURE = `setInterval(() => {}, 1000);\n`;

function fixture(name: string, source: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

function emptyHooks(): HooksConfig {
  return { pre_tool_call: [], post_tool_call: [], session_start: [], session_stop: [] };
}

/** Consent every spec in `hooks`, so a test about running is not also a test about consent. */
function consentAll(hooks: HooksConfig): void {
  const hashes: string[] = [];
  for (const kind of ["pre_tool_call", "post_tool_call", "session_start", "session_stop"] as const) {
    for (const spec of hooks[kind]) hashes.push(hookSpecHash(kind, spec));
  }
  writeConsent(profileDir, hashes);
}

function call(overrides: Partial<HookToolCall> = {}): HookToolCall {
  return { adapter: "terminal", tool: "terminal", args: { command: "ls -la" }, runId: "run_1", stepId: "step_1", seat: "engineer", ...overrides };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-hooks-run-"));
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-hooks-profile-"));
  outFile = path.join(dir, "seen.ndjson");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function seen(): unknown[] {
  if (!fs.existsSync(outFile)) return [];
  return fs
    .readFileSync(outFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

describe("runHook", () => {
  it("spawns the argv, hands the payload on stdin and reports the exit code", async () => {
    const spec: HookSpec = { command: [process.execPath, fixture("record.cjs", RECORD_FIXTURE), outFile] };
    const result = await runHook(spec, toolPayload("pre_tool_call", call()), {});
    expect(result.ran).toBe(true);
    expect(result.code).toBe(0);
    expect(seen()).toHaveLength(1);
    expect((seen()[0] as { hook: string }).hook).toBe("pre_tool_call");
  });

  it("returns the tail of stderr on a non-zero exit", async () => {
    const spec: HookSpec = { command: [process.execPath, fixture("block.cjs", BLOCK_FIXTURE), outFile] };
    const result = await runHook(spec, toolPayload("pre_tool_call", call()), {});
    expect(result.code).toBe(1);
    expect(result.stderrTail).toContain("this workspace forbids that tool");
  });

  it("kills a hook past its timeout and reports the timeout rather than hanging", async () => {
    const spec: HookSpec = { command: [process.execPath, fixture("hang.cjs", HANG_FIXTURE)], timeout_ms: 200 };
    const result = await runHook(spec, toolPayload("pre_tool_call", call()), {});
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("reports an executable that does not exist instead of throwing", async () => {
    const spec: HookSpec = { command: [path.join(dir, "no-such-binary")] };
    const result = await runHook(spec, toolPayload("pre_tool_call", call()), {});
    expect(result.code).not.toBe(0);
    expect(result.error ?? "").not.toBe("");
  });
});

describe("the pre/post tool hook runner", () => {
  it("blocks the call when a pre hook exits non-zero, and the reason carries the hook's stderr", async () => {
    const hooks = { ...emptyHooks(), pre_tool_call: [{ command: [process.execPath, fixture("block.cjs", BLOCK_FIXTURE), outFile] }] };
    consentAll(hooks);
    const runner = createToolHookRunner({ profileDir, hooks });
    const gate = await runner.pre(call());
    expect(gate.blocked).toBe(true);
    expect(gate.blocked ? gate.reason : "").toContain("this workspace forbids that tool");
  });

  it("does not block when the pre hook exits zero", async () => {
    const hooks = { ...emptyHooks(), pre_tool_call: [{ command: [process.execPath, fixture("record.cjs", RECORD_FIXTURE), outFile] }] };
    consentAll(hooks);
    const runner = createToolHookRunner({ profileDir, hooks });
    expect((await runner.pre(call())).blocked).toBe(false);
  });

  it("gives a post hook the result, and a failing post hook never blocks", async () => {
    const hooks = { ...emptyHooks(), post_tool_call: [{ command: [process.execPath, fixture("block.cjs", BLOCK_FIXTURE), outFile] }] };
    consentAll(hooks);
    const runner = createToolHookRunner({ profileDir, hooks });
    await expect(runner.post(call(), { status: "completed", summary: "listed 4 entries" })).resolves.toBeUndefined();
    const payload = seen()[0] as { hook: string; result?: { status: string; summary: string } };
    expect(payload.hook).toBe("post_tool_call");
    expect(payload.result).toEqual({ status: "completed", summary: "listed 4 entries" });
  });

  it("never runs an unconsented hook, and reports it exactly once however many calls are made", async () => {
    const hooks = { ...emptyHooks(), pre_tool_call: [{ command: [process.execPath, fixture("block.cjs", BLOCK_FIXTURE), outFile] }] };
    const runner = createToolHookRunner({ profileDir, hooks });
    expect((await runner.pre(call())).blocked).toBe(false);
    expect((await runner.pre(call())).blocked).toBe(false);
    expect(seen()).toEqual([]);
    expect(runner.notices()).toHaveLength(1);
    expect(runner.notices()[0]).toContain("pre_tool_call");
  });

  it("loses consent when the spec changes, so an edited hook is silent until it is granted again", async () => {
    const original: HookSpec = { command: [process.execPath, fixture("record.cjs", RECORD_FIXTURE), outFile] };
    consentAll({ ...emptyHooks(), pre_tool_call: [original] });
    const edited: HookSpec = { ...original, command: [...original.command, "--changed"] };
    const runner = createToolHookRunner({ profileDir, hooks: { ...emptyHooks(), pre_tool_call: [edited] } });
    await runner.pre(call());
    expect(seen()).toEqual([]);
    expect(runner.notices()).toHaveLength(1);
  });

  it("runs only the hooks whose match.tool names this tool", async () => {
    const hooks = {
      ...emptyHooks(),
      pre_tool_call: [{ command: [process.execPath, fixture("record.cjs", RECORD_FIXTURE), outFile], match: { tool: "write_file" } }],
    };
    consentAll(hooks);
    const runner = createToolHookRunner({ profileDir, hooks });
    await runner.pre(call({ tool: "read_file" }));
    expect(seen()).toEqual([]);
    await runner.pre(call({ tool: "write_file" }));
    expect(seen()).toHaveLength(1);
  });

  it("puts no secret from the tool arguments on the hook's stdin", async () => {
    const hooks = { ...emptyHooks(), pre_tool_call: [{ command: [process.execPath, fixture("record.cjs", RECORD_FIXTURE), outFile] }] };
    consentAll(hooks);
    const runner = createToolHookRunner({ profileDir, hooks });
    await runner.pre(call({ tool: "terminal", args: { command: `curl -H "authorization: Bearer ${FIXTURE_SECRET}" https://api.test`, note: FIXTURE_SECRET } }));
    const raw = fs.readFileSync(outFile, "utf8");
    expect(raw).not.toContain(FIXTURE_SECRET);
    expect(raw).toContain("REDACTED");
    // The shape survives redaction: a hook can still see which tool ran.
    expect((seen()[0] as { tool: string }).tool).toBe("terminal");
  });
});

describe("runSessionHooks", () => {
  it("runs consented session hooks and reports how many ran", async () => {
    const hooks = { ...emptyHooks(), session_start: [{ command: [process.execPath, fixture("record.cjs", RECORD_FIXTURE), outFile] }] };
    consentAll(hooks);
    const report = await runSessionHooks("session_start", { profileDir, hooks, sessionId: "ses_1" });
    expect(report.ran).toBe(1);
    expect(report.skipped).toEqual([]);
    const payload = seen()[0] as { hook: string; session_id?: string };
    expect(payload.hook).toBe("session_start");
    expect(payload.session_id).toBe("ses_1");
  });

  it("skips an unconsented session hook and names it in the report", async () => {
    const hooks = { ...emptyHooks(), session_stop: [{ command: [process.execPath, fixture("record.cjs", RECORD_FIXTURE), outFile] }] };
    const report = await runSessionHooks("session_stop", { profileDir, hooks });
    expect(report.ran).toBe(0);
    expect(report.skipped).toHaveLength(1);
    expect(seen()).toEqual([]);
  });

  it("does not let a failing session hook throw into the caller", async () => {
    const hooks = { ...emptyHooks(), session_stop: [{ command: [process.execPath, fixture("block.cjs", BLOCK_FIXTURE), outFile] }] };
    consentAll(hooks);
    const report = await runSessionHooks("session_stop", { profileDir, hooks });
    expect(report.ran).toBe(1);
    expect(report.failures).toHaveLength(1);
  });
});
