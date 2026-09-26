/**
 * [C11.2] The fleet as the launch's option: `--team` (alias `--fleet`) beside `--solo`.
 *
 * New profiles run solo (setup writes `agent.mode: solo`; `packages/trent-core/src/setup/solo-default.test.ts`), so
 * the fleet needs a way in for one launch, with the same precedence as `--solo`: a launch override beats
 * `agent.mode`, which beats the default for a profile without the key (`fleet`). Naming both runners is a usage
 * error. A bare `trent --dry-run` opens nothing and reports the runner a launch would start. The REPL is the
 * harness's `startRepl`, so nothing starts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { buildProgram, runCli } from "../index.js";
import { modeOverride } from "../../runtime/runner-for-mode.js";

let home: string;

function profile(mode?: "solo" | "fleet", name = "default"): void {
  const manager = new ConfigManager({ profile: name });
  const config = manager.loadConfig();
  const agent = { ...(config.agent as Record<string, unknown>) };
  if (mode === undefined) delete agent.mode;
  else agent.mode = mode;
  manager.saveConfig({ ...config, agent } as typeof config);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-team-"));
  process.env.TRENT_HOME = home;
});
afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

type Launch = { profile: string; continueSession: boolean; mode?: string };

async function launch(argv: string[]): Promise<{ opened: Launch[]; exitCode: number; stdout: string; stderr: string }> {
  const opened: Launch[] = [];
  const result = await runCli(argv, { overrides: { startRepl: async (opts) => void opened.push(opts as Launch) } });
  return { opened, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

describe("[C11.2] trent --team", () => {
  it("`trent --team --json --dry-run` exits 0, opens nothing, and reports the fleet over a solo profile", async () => {
    profile("solo");
    const { opened, exitCode, stdout } = await launch(["--team", "--json", "--dry-run"]);
    expect(exitCode).toBe(EXIT.OK);
    expect(opened).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, command: "trent", launch: "repl", mode: "fleet" });
  });

  it("`--fleet` is the same flag", async () => {
    profile("solo");
    const { exitCode, stdout } = await launch(["--fleet", "--json", "--dry-run"]);
    expect(exitCode).toBe(EXIT.OK);
    expect(JSON.parse(stdout)).toMatchObject({ mode: "fleet" });
  });

  it("opens the fleet REPL for this launch, keeping --continue and --profile, and writes nothing", async () => {
    profile("solo", "work");
    const before = fs.readFileSync(new ConfigManager({ profile: "work" }).getConfigPath(), "utf8");
    const { opened, exitCode } = await launch(["--profile", "work", "--team", "-c"]);
    expect(exitCode).toBe(EXIT.OK);
    expect(opened).toEqual([{ profile: "work", continueSession: true, mode: "fleet" }]);
    expect(fs.readFileSync(new ConfigManager({ profile: "work" }).getConfigPath(), "utf8")).toBe(before);
  });

  it("with no harness, hands the binary the REPL and the fleet", async () => {
    profile("solo");
    const result = await runCli(["--team"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.launch).toBe("repl");
    expect(result.mode).toBe("fleet");
  });

  it("reaches a command's runtime: `trent run --team` names the fleet", async () => {
    profile("solo");
    const result = await runCli(["run", "say ready", "--team", "--json", "--dry-run"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, command: "run", mode: "fleet" });
    expect(modeOverride({ team: true })).toBe("fleet");
    expect(modeOverride({ fleet: true })).toBe("fleet");
    expect(modeOverride({ solo: true })).toBe("solo");
    expect(modeOverride({})).toBeUndefined();
  });

  it("is on every command and on the root, beside --solo", () => {
    const walk = (cmd: Command): Command[] => cmd.commands.flatMap((child) => [child, ...walk(child)]);
    const program = buildProgram({ io: { out: () => undefined, err: () => undefined } });
    for (const flag of ["--team", "--fleet"]) {
      const missing = walk(program).filter((cmd) => !cmd.options.some((option) => option.long === flag)).map((cmd) => cmd.name());
      expect(missing, flag).toEqual([]);
      expect(program.options.some((option) => option.long === flag), flag).toBe(true);
    }
  });
});

describe("[C11.2] --solo and --team together", () => {
  it("is a usage error, exit 2, and opens nothing: bare, through the alias, and on a command", async () => {
    profile("solo");
    for (const argv of [["--solo", "--team"], ["--fleet", "--solo"], ["solo", "--team"], ["run", "say ready", "--solo", "--fleet", "--dry-run"], ["doctor", "--solo", "--team", "--json"]]) {
      const { opened, exitCode, stdout, stderr } = await launch(argv);
      expect(exitCode, argv.join(" ")).toBe(EXIT.USAGE);
      expect(opened, argv.join(" ")).toEqual([]);
      expect(`${stdout}${stderr}`, argv.join(" ")).toMatch(/--solo.*--team|--team.*--solo/);
    }
    expect(() => modeOverride({ solo: true, team: true })).toThrow(/--solo/);
  });
});

describe("[C11.2] the precedence on a bare launch: override, then agent.mode, then the fleet", () => {
  it("an existing profile without agent.mode still runs the fleet", async () => {
    profile(undefined);
    const { stdout, opened } = await launch(["--json", "--dry-run"]);
    expect(opened).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, launch: "repl", mode: "fleet" });
  });

  it("a profile on solo runs solo, and --solo over a fleet profile runs solo", async () => {
    profile("solo");
    expect(JSON.parse((await launch(["--json", "--dry-run"])).stdout)).toMatchObject({ mode: "solo" });
    profile("fleet");
    expect(JSON.parse((await launch(["--solo", "--json", "--dry-run"])).stdout)).toMatchObject({ mode: "solo" });
  });

  it("a first run reports what setup would write, solo, and writes nothing", async () => {
    const { stdout, exitCode } = await launch(["--json", "--dry-run"]);
    expect(exitCode).toBe(EXIT.OK);
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, firstRun: true, mode: "solo" });
    expect(new ConfigManager({ profile: "default" }).exists()).toBe(false);
  });
});

describe("[C11.2] trent --help describes the two modes in one line each", () => {
  it("one line for --solo and one for --team naming the fleet as the option; --fleet as its alias; no 164", async () => {
    const help = (await runCli(["--help"])).stdout;
    // Commander wraps a long description onto indented lines; an entry is its flag line plus those.
    const options = help.slice(help.indexOf("Options:"), help.indexOf("Commands:")).split("\n").slice(1);
    const entries = options.reduce<string[]>((all, line) => (/^\s{2}-/.test(line) ? [...all, line.trim()] : line.trim() === "" ? all : [...all.slice(0, -1), `${all.at(-1) ?? ""} ${line.trim()}`]), []);
    const solo = entries.filter((entry) => /^--solo\b/.test(entry));
    const team = entries.filter((entry) => /^--team\b/.test(entry));
    expect(solo).toHaveLength(1);
    expect(team).toHaveLength(1);
    expect(solo[0]).toMatch(/one agent/);
    expect(team[0]).toMatch(/fleet/);
    expect(team[0]).toMatch(/nine/);
    expect(team[0]).toMatch(/new profiles run solo/);
    expect(entries.some((entry) => /^--fleet\b.*--team/.test(entry))).toBe(true);
    // The count is what the council struck (§4 item 3); C6's `fleet` line names "the catalog specialists" truthfully.
    expect(help).not.toMatch(/\b164\b|\b173\b/);
  });
});

describe("[C11.2] choosing at setup", () => {
  it("`trent setup --team` and `--fleet` hand the wizard the fleet; `--solo` hands it solo", async () => {
    const seen: Record<string, unknown>[] = [];
    const runSetup = async (_mode: unknown, opts: Record<string, unknown>) => {
      seen.push(opts);
      return { mode: "quick" as const, success: true, message: "ok", secretsConfigured: [] };
    };
    for (const flag of ["--team", "--fleet", "--solo"]) {
      const result = await runCli(["setup", flag, "--json"], { overrides: { runSetup } });
      expect(result.exitCode, flag).toBe(EXIT.OK);
    }
    expect(seen.map((opts) => modeOverride(opts))).toEqual(["fleet", "fleet", "solo"]);
  });
});
