/**
 * Item 1: the `file_ops` toolset — Hermes's read_file / write_file / patch / search_files schemas,
 * every operation a shell command on the seat's sandbox, confined to the workspace by realpath.
 * The suite runs against the local backend and, when a Docker daemon answers, against a real
 * container with the workspace mounted at /workspace and no network.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeDockerSandbox } from "../../terminal/docker-test-gate.js";
import { createFileOpsAdapter } from "./index.js";
import type { ToolContext, TrentToolAdapter } from "../types.js";

const FIXTURE_NAME = "trent-fileops-fixture";
const DRIFTED_SOURCE = [
  "export function add(a: number, b: number) {",
  "    return a + b;",
  "}",
  "",
  "export const VERSION = \"1.2.3\";",
  "",
].join("\n");

const gate = await probeDockerSandbox();
const dockerAvailable = gate.ready;

function makeWorkspace(): { workspace: string; profileDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-fileops-"));
  const workspace = path.join(root, "repo");
  const profileDir = path.join(root, "profile");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: FIXTURE_NAME, version: "1.2.3" }, null, 2) + "\n");
  fs.writeFileSync(path.join(workspace, "src", "a.ts"), DRIFTED_SOURCE);
  fs.writeFileSync(path.join(workspace, ".env"), "SECRET_TOKEN=do-not-read\n");
  fs.writeFileSync(path.join(workspace, "CLAUDE.md"), "# instructions\n");
  fs.writeFileSync(path.join(workspace, "big.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  fs.symlinkSync("/etc", path.join(workspace, "escape"));
  return { workspace, profileDir };
}

const backends: Array<{ backend: ToolContext["backend"]; skip: boolean }> = [
  { backend: "local", skip: false },
  { backend: "docker", skip: !dockerAvailable },
];

for (const { backend, skip } of backends) {
  describe.skipIf(skip)(`file_ops on the ${backend} backend${skip ? gate.skipNote : ""}`, () => {
    let workspace = "";
    let profileDir = "";
    let adapter: TrentToolAdapter;

    beforeAll(() => {
      ({ workspace, profileDir } = makeWorkspace());
      adapter = createFileOpsAdapter({ workspace, profileDir, backend, docker: { image: "alpine:3" } });
    });
    afterAll(async () => {
      await adapter.cleanup();
    });

    it("read_file returns the real file, line-numbered, with Hermes's LINE|content shape", async () => {
      const result = await adapter.execute('read_file {"path":"package.json"}', {});
      expect(result.status).toBe("completed");
      const expected = fs
        .readFileSync(path.join(workspace, "package.json"), "utf8")
        .replace(/\n$/, "")
        .split("\n")
        .map((line, i) => `${i + 1}|${line}`)
        .join("\n");
      expect(result.summary).toContain(expected);
      expect(result.summary).toContain(FIXTURE_NAME);
    }, 120_000);

    it("read_file pages with offset/limit and reports next_offset", async () => {
      const first = await adapter.execute('read_file {"path":"big.txt","limit":100}', {});
      expect(first.status).toBe("completed");
      expect(first.summary).toContain("1|line 1");
      expect(first.summary).toContain("100|line 100");
      expect(first.summary).not.toContain("101|line 101");
      expect(first.summary).toMatch(/next_offset[=: ]+101/);
      const second = await adapter.execute('read_file {"path":"big.txt","offset":2990}', {});
      expect(second.summary).toContain("3000|line 3000");
      expect(second.summary).not.toMatch(/next_offset/);
    }, 120_000);

    it("confines every path to the workspace, after symlink resolution", async () => {
      for (const action of [
        'read_file {"path":"../../etc/passwd"}',
        'read_file {"path":"/etc/passwd"}',
        'read_file {"path":"escape/passwd"}',
        'write_file {"path":"../outside.txt","content":"x"}',
      ]) {
        const result = await adapter.execute(action, {});
        expect(result.status, action).toBe("blocked");
        expect(result.summary, action).toMatch(/outside the workspace|denied/);
      }
    }, 120_000);

    it("denies secrets by glob even when approval has been granted", async () => {
      // `execute` is only reached with approval granted or not required; the deny list holds either way.
      const read = await adapter.execute('read_file {"path":".env"}', {});
      expect(read.status).toBe("blocked");
      expect(read.summary).not.toContain("do-not-read");
      const write = await adapter.execute('write_file {"path":".env","content":"SECRET_TOKEN=changed"}', {});
      expect(write.status).toBe("blocked");
      expect(fs.readFileSync(path.join(workspace, ".env"), "utf8")).toBe("SECRET_TOKEN=do-not-read\n");
    }, 120_000);

    it("write_file creates parents and writes exactly the content; writes need approval", async () => {
      const content = "hello\nwith 'quotes' and $(subshell) and unicode é\n";
      const action = `write_file ${JSON.stringify({ path: "notes/new.txt", content })}`;
      expect(adapter.requiresApproval(action)).toBe(true);
      expect(adapter.requiresApproval('read_file {"path":"package.json"}')).toBe(false);
      const result = await adapter.execute(action, {});
      expect(result.status).toBe("completed");
      expect(fs.readFileSync(path.join(workspace, "notes", "new.txt"), "utf8")).toBe(content);
    }, 120_000);

    it("protected instruction files always need approval, even with auto-approved writes", () => {
      const auto = createFileOpsAdapter({ workspace, profileDir, backend: "local", autoApproveWrites: true });
      expect(auto.requiresApproval('write_file {"path":"notes/x.md","content":"x"}')).toBe(false);
      expect(auto.requiresApproval('write_file {"path":"CLAUDE.md","content":"x"}')).toBe(true);
      expect(auto.requiresApproval('patch {"path":"AGENTS.md","old_string":"a","new_string":"b"}')).toBe(true);
      expect(auto.requiresApproval('write_file {"path":".trent/policy.yaml","content":"x"}')).toBe(true);
    });

    it("patch applies a whitespace-drifted old_string and returns a unified diff", async () => {
      const result = await adapter.execute(
        `patch ${JSON.stringify({ path: "src/a.ts", old_string: "export function add(a: number, b: number) {\n  return a + b;\n}", new_string: "export function add(a: number, b: number) {\n    return b + a;\n}" })}`,
        {},
      );
      expect(result.status).toBe("completed");
      expect(result.summary).toMatch(/^--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n@@/m);
      expect(result.summary).toContain("-    return a + b;");
      expect(result.summary).toContain("+    return b + a;");
      expect(fs.readFileSync(path.join(workspace, "src", "a.ts"), "utf8")).toContain("    return b + a;");
    }, 120_000);

    it("patch refuses an ambiguous match instead of guessing", async () => {
      const result = await adapter.execute('patch {"path":"big.txt","old_string":"line 1","new_string":"x"}', {});
      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(/matches|ambiguous|replace_all/i);
    }, 120_000);

    it("search_files finds content with LINE numbers and never surfaces a denied file", async () => {
      const content = await adapter.execute('search_files {"pattern":"TOKEN=|VERSION","target":"content"}', {});
      expect(content.status).toBe("completed");
      expect(content.summary).toMatch(/^1 content match/);
      expect(content.summary).toMatch(/src\/a\.ts:5:/);
      expect(content.summary).not.toContain(".env");
      expect(content.summary).not.toContain("SECRET_TOKEN");
      const files = await adapter.execute('search_files {"pattern":"*.ts","target":"files"}', {});
      expect(files.status).toBe("completed");
      expect(files.summary).toContain("src/a.ts");
    }, 120_000);

    it("explains the wire shape on a malformed action instead of failing silently", async () => {
      const result = await adapter.execute("read the file please", {});
      expect(result.status).toBe("failed");
      expect(result.summary).toContain("read_file");
      const inferred = await adapter.execute('{"path":"package.json"}', {});
      expect(inferred.status).toBe("completed");
    }, 120_000);
  });
}
