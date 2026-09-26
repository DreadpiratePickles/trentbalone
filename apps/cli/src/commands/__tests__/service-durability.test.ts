/**
 * [C10] The always-on service says when it will forget. A daemon started from Node opens no durable
 * store (`apps/cli/src/runtime/headless.ts` `openStore`: no `bun:sqlite`, so `EphemeralStore`), and its
 * runs, improve drafts, held approvals and audit chain vanish at every restart. `trent service install`
 * says so before it writes a unit that would do that, by the rule `@trent/core/store/durability.ts`
 * states, and refuses under Node unless `--allow-ephemeral`; the daemon says so once at start.
 *
 * The runtime the unit would run is faked the way service.test.ts fakes it: the process view handed to
 * `setServiceHostForTests` (`bunVersion` present for Bun and the compiled binary). No launchctl or
 * systemctl runs and nothing is written outside the scratch directory. (service.test.ts is near 500
 * lines, so this lives beside it.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { ServiceProcessView } from "@trent/core/service/index.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import { runCli } from "../index.js";
import { setServiceHostForTests } from "../groups/service.js";

const REFUSAL = "This service would forget its runs, approvals and audit on every restart (Node has no durable store); run it from the binary or Bun, or pass --allow-ephemeral";

const NODE: ServiceProcessView = { execPath: "/usr/local/bin/node", argv: ["/usr/local/bin/node", "/opt/trent/dist/index.js", "service", "install"], execArgv: [] };
const BINARY: ServiceProcessView = { execPath: "/opt/homebrew/bin/trent", argv: ["bun", "/$bunfs/root/trent", "service", "install"], execArgv: [], bunVersion: "1.4.2" };
const BUN_SOURCE: ServiceProcessView = { execPath: "/Users/f/.bun/bin/bun", argv: ["/Users/f/.bun/bin/bun", "/repo/apps/cli/src/index.ts", "service", "install"], execArgv: [], bunVersion: "1.4.2" };

let scratch: string;
let trentHome: string;
let unitPath: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-service-durable-"));
  trentHome = path.join(scratch, ".trent");
  unitPath = path.join(scratch, "Library", "LaunchAgents", "uk.let-trent.default.plist");
  process.env.TRENT_HOME = trentHome;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setServiceHostForTests(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(scratch, { recursive: true, force: true });
});

function useHost(processView: ServiceProcessView): void {
  setServiceHostForTests({
    platform: "darwin",
    homeDir: scratch,
    uid: 501,
    exec: () => ({ code: 0, stdout: "", stderr: "" }),
    processView,
    realpath: (p) => p,
    cwd: path.join(scratch, "work"),
    pathEnv: "/usr/local/bin:/usr/bin:/bin",
  });
}

describe("trent service install says whether the daemon will keep its store", () => {
  // A dry run writes nothing, so it refuses nothing: it reports what the real install would do, exit 0
  // (registry.test.ts pins exit 0 for every command's `--json --dry-run`).
  it("under Node, --dry-run --json exits 0, reports durable: false, and says the real install would refuse", async () => {
    useHost(NODE);
    const result = await runCli(["service", "install", "--dry-run", "--json"]);
    const data = JSON.parse(result.stdout) as { durable?: boolean; wouldRefuse?: boolean; message?: string; reason?: string; state?: string };
    expect({ exitCode: result.exitCode, durable: data.durable, wouldRefuse: data.wouldRefuse }).toEqual({ exitCode: EXIT.OK, durable: false, wouldRefuse: true });
    expect(data.message).toBe(REFUSAL);
    expect(data.state).toBe("would-write");
    // The reason is the store's own line (store/durability.ts), not a second wording of it.
    expect(data.reason).toMatch(/^the SQLite store needs Bun/);
    expect(fs.existsSync(unitPath)).toBe(false);
    const human = await runCli(["service", "install", "--dry-run", "--no-color"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toMatch(/^\s*store\s+not durable: the SQLite store needs Bun/m);
    expect(human.stdout).toContain(REFUSAL);
  });

  it("under Node, a real install without the flag exits 3 with the line and writes nothing", async () => {
    useHost(NODE);
    const json = await runCli(["service", "install", "--json"]);
    expect(json.exitCode).toBe(EXIT.CONFIG);
    expect(JSON.parse(json.stdout)).toMatchObject({ command: "service install", durable: false, message: REFUSAL, reason: expect.stringMatching(/^the SQLite store needs Bun/) });
    const result = await runCli(["service", "install", "--no-color"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain(REFUSAL);
    expect(fs.existsSync(unitPath)).toBe(false);
  });

  it("under Node, --allow-ephemeral installs as today and still reports durable: false", async () => {
    useHost(NODE);
    const dry = await runCli(["service", "install", "--dry-run", "--allow-ephemeral", "--json"]);
    expect(dry.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, state: "would-write", durable: false, reason: expect.stringMatching(/^the SQLite store needs Bun/) });
    expect(JSON.parse(dry.stdout)).not.toHaveProperty("wouldRefuse");
    expect(fs.existsSync(unitPath)).toBe(false);

    const written = await runCli(["service", "install", "--allow-ephemeral", "--json"]);
    expect(written.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(written.stdout)).toMatchObject({ state: "written", durable: false, programArguments: ["/usr/local/bin/node", "/opt/trent/dist/index.js", "service", "daemon", "--profile", "default", "--no-color"] });
    expect(fs.existsSync(unitPath)).toBe(true);

    const human = await runCli(["service", "install", "--allow-ephemeral", "--no-color"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toMatch(/^\s*store\s+not durable: the SQLite store needs Bun/m);
  });

  it("from the compiled binary it reports durable: true and installs without the flag", async () => {
    useHost(BINARY);
    const result = await runCli(["service", "install", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(data).toMatchObject({ state: "written", durable: true, programArguments: ["/opt/homebrew/bin/trent", "service", "daemon", "--profile", "default", "--no-color"] });
    expect(data).not.toHaveProperty("reason");
    expect(data).not.toHaveProperty("wouldRefuse");
    const human = await runCli(["service", "install", "--no-color"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toMatch(/^\s*store\s+durable\b/m);
    expect(human.stdout).not.toContain(REFUSAL);
  });

  it("under Bun running the source it reports durable: true on --dry-run", async () => {
    useHost(BUN_SOURCE);
    const result = await runCli(["service", "install", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, state: "would-write", durable: true });
    expect(JSON.parse(result.stdout)).not.toHaveProperty("wouldRefuse");
  });
});

describe("trent service daemon under a store that is not durable", () => {
  function configure(): void {
    const manager = new ConfigManager({ profile: "default" });
    const config = manager.loadConfig();
    manager.saveConfig({ ...config, gateway: { ...config.gateway, enabled: false }, heartbeat: { ...config.heartbeat, enabled: false } });
  }

  /** A runtime whose `durable` is as given, and stand-in signals so SIGTERM releases every lock. */
  function fakes(durable: boolean): { overrides: CliOverrides; raise: (event: string) => Promise<void> } {
    const order: string[] = [];
    const listeners = new Map<string, Array<() => void>>();
    const signals = {
      once(event: string, listener: () => void): unknown {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return undefined;
      },
      exit(code: number): void {
        order.push(`exit:${String(code)}`);
      },
    };
    const runtime = {
      orchestrator: { approve: vi.fn(async () => true), reject: vi.fn(async () => true) },
      companyId: "trent-local",
      store: {},
      durable,
      run: () =>
        (async function* (): AsyncGenerator<OrcEvent> {
          yield { kind: "run_done", runId: "run_svc", at: "2026-09-26T09:00:00.000Z", run: { status: "completed", summary: "NO_REPLY" } } as OrcEvent;
        })(),
      cleanup: vi.fn(async () => undefined),
    } as unknown as HeadlessRuntime;
    return {
      overrides: { signals, now: () => new Date("2026-09-26T09:00:00.000Z"), gatewayRuntime: async () => runtime },
      async raise(event) {
        for (const listener of listeners.get(event) ?? []) listener();
        for (let i = 0; i < 200 && !order.some((entry) => entry.startsWith("exit:")); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      },
    };
  }

  function serviceLog(): string[] {
    const file = path.join(trentHome, "logs", "service.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd().split("\n").map((line) => line.replace(/^\S+ service\[\d+\] /, "")) : [];
  }

  it("logs one service.ephemeral_store line at start, naming why, and echoes it", async () => {
    configure();
    const f = fakes(false);
    const result = await runCli(["service", "daemon", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const lines = serviceLog().filter((line) => line.startsWith("service.ephemeral_store"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^service\.ephemeral_store: not durable: the SQLite store needs Bun .*; runs, approvals and audit are lost when this process exits$/);
    // Said at start: before any component reports.
    expect(serviceLog().slice(0, 2)).toEqual(["service starting: profile default", lines[0]]);
    expect(result.stderr).toContain("service.ephemeral_store: not durable");
    await f.raise("SIGTERM");
  });

  it("a durable runtime logs no such line", async () => {
    configure();
    const f = fakes(true);
    expect((await runCli(["service", "daemon", "--json"], { overrides: f.overrides })).exitCode).toBe(EXIT.OK);
    expect(serviceLog().some((line) => line.includes("ephemeral_store"))).toBe(false);
    await f.raise("SIGTERM");
  });
});
