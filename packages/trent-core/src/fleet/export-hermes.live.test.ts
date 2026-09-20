/**
 * W5 — the live proof for `fleet export --target hermes`: a real Hermes install imports the
 * exported archive (`hermes profile import`) and installs the exported directory (`hermes profile
 * install`), lists both profiles, reads the manifest back through `hermes profile info`, and the
 * profiles are deleted again. Gated by TRENT_TEST_LIVE=1 (the vitest config excludes `*.live.test`
 * otherwise). With no `hermes` on the PATH the suite is skipped with that reason in its name;
 * nothing here installs Hermes. No model is called: a profile import is file handling.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { InMemoryImproveStore } from "../improve/memory-store.js";
import type { AgentDefinition } from "../store/StorePort.js";
import { createAgentVersions, type AgentDefinitionSource } from "./AgentVersions.js";
import { exportHermesProfiles } from "./export-hermes.js";

function hermesOnPath(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "hermes");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* next dir */
    }
  }
  return undefined;
}

const HERMES = hermesOnPath();
const reason = HERMES === undefined ? " (skipped: no hermes executable on the PATH; Hermes is not installed by this test)" : "";

function hermes(...args: string[]): string {
  return execFileSync(HERMES!, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 55_000 });
}

function source(): AgentDefinitionSource {
  return {
    async definition(agentId): Promise<AgentDefinition> {
      return {
        prompt: `You are the ${agentId} seat. Ship small commits.`,
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
        toolsets: ["file_ops", "terminal"],
        skills: [{ slug: "repo-audit", content: "# Repository Audit\n> Map the codebase.\n\nList every package." }],
      };
    },
  };
}

const stamp = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const IMPORTED = `trent-live-import-${stamp}`;
const INSTALLED = `trent-live-install-${stamp}`;
const created: string[] = [];
const dirs: string[] = [];

afterAll(() => {
  for (const name of created.splice(0)) {
    try {
      hermes("profile", "delete", name, "--yes");
    } catch {
      /* already gone, or never created */
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(HERMES === undefined)(`a real Hermes accepts the exported profile${reason}`, () => {
  it("imports the archive, installs the directory, lists both and reads the manifest back", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "trent-hermes-live-"));
    dirs.push(out);
    const versions = createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co", source: source() });
    const result = await exportHermesProfiles({ versions, target: "engineer", dir: out, profileDir: out, profile: "default" });
    const profile = result.profiles[0]!;

    created.push(IMPORTED);
    const imported = hermes("profile", "import", profile.archive, "--name", IMPORTED);
    expect(imported).toContain(IMPORTED);

    created.push(INSTALLED);
    const installed = hermes("profile", "install", profile.dir, "--name", INSTALLED, "--yes");
    expect(installed).toContain(INSTALLED);

    const list = hermes("profile", "list");
    expect(list).toContain(IMPORTED);
    expect(list).toContain(INSTALLED);

    // The manifest Hermes read back is ours: the seat's version and the env names, no values.
    const info = hermes("profile", "info", INSTALLED);
    expect(info).toContain("1.0.0");
    expect(info).toContain("TRENT_HOME");
    for (const name of [IMPORTED, INSTALLED]) {
      const dir = path.join(os.homedir(), ".hermes", "profiles", name);
      expect(fs.existsSync(path.join(dir, "SOUL.md")), `${name}/SOUL.md`).toBe(true);
      expect(fs.existsSync(path.join(dir, "config.yaml")), `${name}/config.yaml`).toBe(true);
      expect(fs.existsSync(path.join(dir, "skills", "repo-audit", "SKILL.md")), `${name}/skills`).toBe(true);
      expect(fs.readFileSync(path.join(dir, "SOUL.md"), "utf8")).toContain("Ship small commits.");
    }
    // The install honours `distribution_owned`: the plain bundle beside the profile is not a profile file.
    expect(fs.existsSync(path.join(os.homedir(), ".hermes", "profiles", INSTALLED, "agent.json"))).toBe(false);
  });
});
