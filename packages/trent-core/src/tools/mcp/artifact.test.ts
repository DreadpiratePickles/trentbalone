/**
 * [D13] The stdio artifact pin: what a consent records about the code that actually runs, so an
 * `npx some-pkg@latest` (or an edited `server.js`) cannot change underneath a stored consent.
 *
 * Package launchers must name an exact version (registries do not let a published version change);
 * a script run by an interpreter and a plain binary are pinned by a content digest, re-checked
 * before every spawn with a stat fast path so an unchanged file is not re-hashed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../config/schema.js";
import { resolveMcpArtifact, verifyMcpArtifact, type McpArtifactPin } from "./artifact.js";

type Stdio = Extract<McpServerConfig, { transport: "stdio" }>;

let root = "";
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-artifact-")));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function stdio(command: string, args: string[] = [], env: Record<string, string> = {}): Stdio {
  return { transport: "stdio", command, args, env, auto_approve: [], enabled: true };
}

const opts = () => ({ cwd: root, env: { PATH: "/nonexistent-bin" } });

function pinned(config: Stdio): McpArtifactPin {
  const resolved = resolveMcpArtifact(config, opts());
  if (!resolved.ok) throw new Error(`expected a pin, got: ${resolved.reason}`);
  return resolved.pin;
}

function refusal(config: Stdio): { code: string; reason: string } {
  const resolved = resolveMcpArtifact(config, opts());
  if (resolved.ok) throw new Error("expected a refusal, got a pin");
  return resolved;
}

describe("[D13] package launchers need an exact version", () => {
  it.each([
    ["npx", ["-y", "some-mcp-server"]],
    ["npx", ["some-mcp-server@latest"]],
    ["npx", ["-y", "@scope/server@^1.2.0"]],
    ["npx", ["--package", "some-mcp-server", "some-bin"]],
    ["bunx", ["some-mcp-server@next"]],
    ["pnpm", ["dlx", "some-mcp-server"]],
    ["npm", ["exec", "some-mcp-server@1"]],
    ["uvx", ["mcp-server-git"]],
    ["uvx", ["mcp-server-git>=0.6"]],
    ["uvx", ["--with", "requests", "mcp-server-git==0.6.2"]],
    ["pipx", ["run", "mcp-server-git"]],
    ["docker", ["run", "-i", "--rm", "mcp/server:latest"]],
    ["docker", ["run", "-i", "--rm", "mcp/server"]],
  ])("%s %j is refused as unpinned, naming the fix", (command, args) => {
    const r = refusal(stdio(command, args));
    expect(r.code).toBe("unpinned");
    expect(r.reason).toMatch(/exact version|sha256 digest/i);
  });

  it.each([
    ["npx", ["-y", "some-mcp-server@1.2.3"]],
    ["npx", ["-y", "@scope/server@1.2.3-beta.1"]],
    ["npx", ["--package=some-mcp-server@2.0.0", "some-bin"]],
    ["pnpm", ["dlx", "some-mcp-server@1.0.0"]],
    ["uvx", ["mcp-server-git==0.6.2"]],
    ["uvx", ["mcp-server-git@0.6.2"]],
    ["uvx", ["--from", "mcp-server-git==0.6.2", "mcp-server-git", "--repository", "."]],
    ["pipx", ["run", "--spec", "mcp-server-git==0.6.2", "mcp-server-git"]],
    ["docker", ["run", "-i", "--rm", `mcp/server@sha256:${"a".repeat(64)}`]],
  ])("%s %j is pinned as a package", (command, args) => {
    expect(pinned(stdio(command, args)).kind).toBe("package");
  });

  it("the digest changes with the version and holds for the same spec", () => {
    const a = pinned(stdio("npx", ["-y", "some-mcp-server@1.2.3"]));
    const b = pinned(stdio("npx", ["-y", "some-mcp-server@1.2.4"]));
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.digest).not.toBe(b.digest);
    expect(verifyMcpArtifact(stdio("npx", ["-y", "some-mcp-server@1.2.3"]), a, opts())).toEqual({ ok: true });
    expect(verifyMcpArtifact(stdio("npx", ["-y", "some-mcp-server@1.2.4"]), a, opts()).ok).toBe(false);
  });
});

describe("[D13] scripts and binaries are pinned by content", () => {
  it("a node script: unchanged verifies, an edited script is refused", () => {
    const script = path.join(root, "server.mjs");
    fs.writeFileSync(script, "console.log('v1');\n");
    const config = stdio(process.execPath, [script]);
    const pin = pinned(config);
    expect(pin.kind).toBe("file");
    expect(verifyMcpArtifact(config, pin, opts())).toEqual({ ok: true });
    fs.appendFileSync(script, "// a quiet change\n");
    const after = verifyMcpArtifact(config, pin, opts());
    expect(after.ok).toBe(false);
    expect(after.ok ? "" : after.reason).toMatch(/changed since consent/i);
  });

  it("a script rewritten with identical bytes still verifies (the stat fast path falls back to the hash)", () => {
    const script = path.join(root, "same.mjs");
    fs.writeFileSync(script, "console.log('same');\n");
    const config = stdio("node", ["./same.mjs"]);
    const pin = pinned(config);
    fs.rmSync(script);
    fs.writeFileSync(script, "console.log('same');\n");
    expect(verifyMcpArtifact(config, pin, opts())).toEqual({ ok: true });
  });

  it("a relative script resolves against cwd: another cwd with another file is refused", () => {
    const other = fs.mkdtempSync(path.join(root, "other-"));
    fs.writeFileSync(path.join(root, "rel.py"), "print('a')\n");
    fs.writeFileSync(path.join(other, "rel.py"), "print('b')\n");
    const config = stdio("python3", ["rel.py"]);
    const pin = pinned(config);
    expect(verifyMcpArtifact(config, pin, { cwd: other, env: {} }).ok).toBe(false);
  });

  it("a plain binary found on PATH is pinned by its bytes", () => {
    const bin = fs.mkdtempSync(path.join(root, "bin-"));
    const exe = path.join(bin, "my-mcp-server");
    fs.writeFileSync(exe, "#!/bin/sh\necho v1\n", { mode: 0o755 });
    const config = stdio("my-mcp-server", ["--stdio"]);
    const env = { PATH: `/nonexistent:${bin}` };
    const resolved = resolveMcpArtifact(config, { cwd: root, env });
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.pin.kind).toBe("file");
    expect(verifyMcpArtifact(config, resolved.pin, { cwd: root, env })).toEqual({ ok: true });
    fs.writeFileSync(exe, "#!/bin/sh\necho v2 && curl evil\n", { mode: 0o755 });
    expect(verifyMcpArtifact(config, resolved.pin, { cwd: root, env }).ok).toBe(false);
  });

  it("an npm-installed bin is also pinned by its package.json, so an upgrade with an identical entry file is refused", () => {
    const pkg = path.join(root, "global", "node_modules", "some-server");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "some-server", version: "1.0.0" }));
    fs.writeFileSync(path.join(pkg, "cli.js"), "#!/usr/bin/env node\nrequire('./lib');\n", { mode: 0o755 });
    const bin = path.join(root, "global", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(path.join(pkg, "cli.js"), path.join(bin, "some-server"));
    const config = stdio(path.join(bin, "some-server"));
    const pin = pinned(config);
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "some-server", version: "1.0.1" }));
    expect(verifyMcpArtifact(config, pin, opts()).ok).toBe(false);
  });

  it("a command that cannot be found is unresolved, not pinned", () => {
    const r = refusal(stdio("no-such-mcp-server-binary"));
    expect(r.code).toBe("unresolved");
    expect(r.reason).toMatch(/not found/i);
  });

  it("a removed script is refused at verify time", () => {
    const script = path.join(root, "gone.mjs");
    fs.writeFileSync(script, "1;\n");
    const config = stdio("node", [script]);
    const pin = pinned(config);
    fs.rmSync(script);
    expect(verifyMcpArtifact(config, pin, opts()).ok).toBe(false);
  });
});

describe("[D13] forms that cannot be pinned fail closed", () => {
  it.each([
    ["python3", ["-m", "mcp_server_git"]],
    ["sh", ["-c", "npx some-mcp-server"]],
    ["env", ["npx", "some-mcp-server"]],
    ["node", ["--no-warnings"]],
  ])("%s %j is refused", (command, args) => {
    expect(resolveMcpArtifact(stdio(command, args), opts()).ok).toBe(false);
  });

  it("env unwraps to the command it runs", () => {
    expect(pinned(stdio("env", ["FOO=1", "npx", "-y", "some-mcp-server@1.2.3"])).kind).toBe("package");
  });

  it("inline code is pinned by the argv the launch spec already hashes", () => {
    expect(pinned(stdio("node", ["-e", "console.log(1)"])).kind).toBe("inline");
  });
});
