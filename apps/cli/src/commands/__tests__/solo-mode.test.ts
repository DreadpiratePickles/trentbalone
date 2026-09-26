/**
 * [S2] The launch override: `--solo` on every command, and `trent solo`, an alias that starts the
 * REPL in solo mode. Both override `agent.mode` for one launch and write nothing; bare `trent`
 * leaves the choice to the config. The REPL is the harness's `startRepl`, so nothing starts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { COMMAND_SPECS, buildProgram, runCli } from "../index.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-solo-"));
  process.env.TRENT_HOME = home;
  const manager = new ConfigManager({ profile: "default" });
  manager.updateConfig({ ...manager.loadConfig() });
});
afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

type Launch = { profile: string; continueSession: boolean; mode?: string };

async function launch(argv: string[]): Promise<{ opened: Launch[]; exitCode: number }> {
  const opened: Launch[] = [];
  const result = await runCli(argv, { overrides: { startRepl: async (opts) => void opened.push(opts as Launch) } });
  return { opened, exitCode: result.exitCode };
}

describe("[S2] trent solo and --solo", () => {
  it("`trent solo` starts the REPL in solo mode", async () => {
    const { opened, exitCode } = await launch(["solo"]);
    expect(exitCode).toBe(EXIT.OK);
    expect(opened).toEqual([{ profile: "default", continueSession: false, mode: "solo" }]);
  });

  it("`trent --solo` does the same, and keeps --continue and --profile", async () => {
    new ConfigManager({ profile: "work" }).updateConfig(new ConfigManager({ profile: "work" }).loadConfig());
    const { opened } = await launch(["--profile", "work", "--solo", "-c"]);
    expect(opened).toEqual([{ profile: "work", continueSession: true, mode: "solo" }]);
  });

  it("bare `trent` names no mode: agent.mode decides", async () => {
    const { opened } = await launch([]);
    expect(opened).toEqual([{ profile: "default", continueSession: false }]);
  });

  it("with no harness, hands the binary the REPL and the mode", async () => {
    const result = await runCli(["solo"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.launch).toBe("repl");
    expect(result.mode).toBe("solo");
    expect((await runCli([])).mode).toBeUndefined();
  });

  it("is a registered command, listed by --help, and --solo is on every command", async () => {
    expect(COMMAND_SPECS.map((spec) => spec.name.split(" ")[0])).toContain("solo");
    const help = await runCli(["--help"]);
    expect(help.stdout).toMatch(/\n\s+solo\b/);
    const walk = (cmd: Command): Command[] => cmd.commands.flatMap((child) => [child, ...walk(child)]);
    const program = buildProgram({ io: { out: () => undefined, err: () => undefined } });
    const missing = walk(program).filter((cmd) => !cmd.options.some((option) => option.long === "--solo")).map((cmd) => cmd.name());
    expect(missing).toEqual([]);
    expect(program.options.some((option) => option.long === "--solo")).toBe(true);
  });

  it("writes nothing: the config's agent.mode is untouched by a solo launch", async () => {
    const before = fs.readFileSync(new ConfigManager({ profile: "default" }).getConfigPath(), "utf8");
    await launch(["solo"]);
    expect(fs.readFileSync(new ConfigManager({ profile: "default" }).getConfigPath(), "utf8")).toBe(before);
  });
});
