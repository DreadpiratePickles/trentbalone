/**
 * The classic REPL, wired to the real thing.
 *
 * Everything the user types goes to `createOrchestrator()`, which streams real events
 * from the real 20-kind bus over the real model gateway. There is no canned reply path
 * in this file or in any file it imports; `__tests__/no-canned.test.ts` enforces that.
 */

import process from "node:process";
import { ConfigManager, SessionManager } from "@trent/core";
import { createOrchestrator as createRealOrchestrator } from "@trent/core/orchestrator/index.js";
import { InMemoryTraceStore } from "@trent/core/traces/index.js";
import { autoTheme, canUseRawMode, terminalWidth, type Theme } from "../ui/index.js";
import { playBoot, type BootStdin } from "../ui/boot.js";
import { ReplEngine, bindApprovalAnswers, type ReplRunner } from "./engine.js";
import { EphemeralStore } from "./ephemeral-store.js";
import { isDegraded } from "./degraded.js";
import { ESCAPE_TIMEOUT_MS, withKittyProtocol } from "./keys.js";
import { withRawMode } from "./interrupt.js";
import { toolsStatusLine, wireTools, type ToolWiring, type ToolWiringDeps } from "./tools.js";
import { fleetMemoryToolListing, wireFleetMemory } from "./fleet-memory.js";
import { wireImproveLoop } from "./improve-loop.js";
import type { ReplConfig, ReplStore } from "./types.js";

export { ReplEngine, bindApprovalAnswers } from "./engine.js";
export { TranscriptRenderer, renderTranscript, identityForRole } from "./render.js";
export { BudgetLedger, formatCents } from "./budget.js";
export { ApprovalGate, renderApprovalCard } from "./approvals.js";
export { REPL_COMMANDS, runCommand, commandNames } from "./commands.js";
export { isDegraded, renderDegradedBanner } from "./degraded.js";
export { KeyDecoder, NEWLINE_HINT } from "./keys.js";
export { wireTools, toolsStatusLine, startEgressProxy, probeDockerCli, FLOOR_IMAGE } from "./tools.js";
export { wireFleetMemory, fleetMemoryToolListing } from "./fleet-memory.js";
export type { FleetMemoryWiringDeps } from "./fleet-memory.js";
export type { ToolWiring, ToolWiringDeps, EgressHandle, StartEgressInput, DockerProbe } from "./tools.js";
export type { ReplContext, ReplStore, ReplToolListing, ReplSandbox, ReplEgressStatus } from "./types.js";

/** Exit code for Ctrl+C during the boot sequence: 128 + SIGINT, the shell convention. */
export const BOOT_INTERRUPT_EXIT_CODE = 130;

/** The stdin the REPL reads: the boot listener plus what the key loop and raw mode need. */
export interface ReplStdin extends BootStdin {
  setEncoding(encoding: BufferEncoding): unknown;
  once(event: "end" | "close", listener: () => void): unknown;
}

/**
 * The terminal, as an injectable. `ClassicRepl` defaults to the process streams; the tests hand
 * in scripted ones so the boot and the first prompt can be asserted without a TTY.
 */
export interface ReplIo {
  write(text: string): void;
  isTTY: boolean;
  stdin: ReplStdin;
  exit(code: number): void;
  theme?: Theme;
  width?: number;
  /** Injectable clock for the boot animation. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The collaborators `start()` builds the session from. Defaults are the real ones; the tests
 * inject a recording orchestrator factory, an observed proxy and a Docker probe that needs no daemon.
 */
export interface ReplDeps {
  /** The directory `trent` was launched in. Defaults to `process.cwd()`; never the home directory. */
  workspace?: string;
  createOrchestrator?: typeof createRealOrchestrator;
  buildAdapters?: ToolWiringDeps["buildAdapters"];
  startEgress?: ToolWiringDeps["startEgress"];
  probeDocker?: ToolWiringDeps["probeDocker"];
}

export interface ReplOptions {
  continueSession?: boolean;
  profile?: string;
  io?: ReplIo;
  deps?: ReplDeps;
}

/** The company a local session runs against when config names none. Found again by slug on restart. */
const DEFAULT_COMPANY = { name: "Trent Local", slug: "trent-local" } as const;

function processIo(): ReplIo {
  return {
    write: (text) => void process.stdout.write(text),
    isTTY: process.stdout.isTTY === true,
    stdin: process.stdin as unknown as ReplStdin,
    exit: (code) => process.exit(code),
  };
}

/** Opens the durable store, or says plainly that this session will not persist. */
async function openStore(databaseUrl: string): Promise<{ store: ReplStore; durable: boolean }> {
  try {
    const { createSqliteStore } = await import("@trent/core/store/index.js");
    return { store: (await createSqliteStore({ url: databaseUrl })) as unknown as ReplStore, durable: true };
  } catch {
    // bun:sqlite is unavailable under plain Node. Never silently degrade: the caller
    // prints a warning, and approvals will not survive this process.
    return { store: new EphemeralStore(), durable: false };
  }
}

export class ClassicRepl {
  readonly #configManager: ConfigManager;
  readonly #sessions: SessionManager;
  readonly #io: ReplIo;
  readonly #deps: ReplDeps;

  constructor(options: ReplOptions = {}) {
    this.#configManager = new ConfigManager({ profile: options.profile });
    this.#sessions = new SessionManager(this.#configManager);
    this.#io = options.io ?? processIo();
    this.#deps = options.deps ?? {};
    if (options.continueSession === true) this.#sessions.resumeLastSession();
  }

  async start(): Promise<void> {
    const io = this.#io;
    const theme = io.theme ?? autoTheme();
    const config = this.#configManager.loadConfig() as unknown as ReplConfig;
    // Parses the profile's .env AND exports every key into process.env, which is where the
    // gateway reads them. Values are never read here.
    const secrets = this.#configManager.loadSecrets() as unknown as Record<string, string | undefined>;
    const degraded = isDegraded({ ...process.env, ...secrets });
    const width = io.width ?? terminalWidth();
    const writeLine = (line: string): void => io.write(`${line}\n`);

    // The boot sequence, before anything else is on screen. Ctrl+C here is a clean exit; any
    // other key skips to the final frame. Without a TTY or colour only the static frame is drawn.
    const boot = await playBoot(
      { agents: config.fleet.installed_agents ?? config.fleet.active_agents, width, colorMode: theme.mode },
      { write: (text) => io.write(text), isTTY: io.isTTY, stdin: io.stdin, sleep: io.sleep },
    );
    if (boot.interrupted) {
      io.exit(BOOT_INTERRUPT_EXIT_CODE);
      return;
    }

    const profileDir = this.#configManager.getProfileDir();

    // The seats' toolsets and the egress proxy, before the first turn. The workspace is where
    // `trent` was launched, never the home directory. Everything from here on is released by
    // `tools.cleanup()` on every exit path: stdin end, a throw, and Ctrl+C.
    const tools: ToolWiring = await wireTools({
      config: config as unknown as ToolWiringDeps["config"],
      workspace: this.#deps.workspace ?? process.cwd(),
      profileDir,
      configManager: this.#configManager,
      buildAdapters: this.#deps.buildAdapters,
      startEgress: this.#deps.startEgress,
      probeDocker: this.#deps.probeDocker,
    });
    writeLine(toolsStatusLine(tools, theme));

    let exiting: Promise<void> | undefined;
    const exit = (code: number): void => {
      // Ctrl+C is a key here (raw mode), so the proxy and the sandboxes are stopped BEFORE the
      // process goes; `process.exit` would otherwise leave the listener and the containers behind.
      exiting ??= tools.cleanup().finally(() => io.exit(code));
    };

    try {
      const databaseUrl = `file:${profileDir}/trent.db`;
      const { store, durable } = await openStore(databaseUrl);

      // The company memory every seat shares: MEMORY.md / USER.md under the profile, recall over
      // this company's runs, and the shared skills index when the store carries the improve tables.
      const fleetMemory = wireFleetMemory({ profileDir, store });
      // The self-improvement loop: traces from every run, and promoted skills back into every seat.
      const improve = wireImproveLoop({ store, config });

      // The configured provider/model travel with the orchestrator, which maps them into the env
      // its model resolver reads before the first apps/web import (live proof, F2).
      const createOrchestrator = this.#deps.createOrchestrator ?? createRealOrchestrator;
      const orchestrator = createOrchestrator({
        ...(durable ? { databaseUrl } : {}),
        model: { provider: config.provider, model: config.model },
        tools: tools.adapters,
        fleetMemory,
        ...improve,
      });
      // `launchOrchestration` throws "Company not found" for an id nothing created; an explicit
      // config id is trusted, otherwise the local company is found by slug or created.
      const configuredId = (config as { company?: { id?: string } }).company?.id;
      const companyId = configuredId !== undefined ? String(configuredId) : await orchestrator.ensureCompany(DEFAULT_COMPANY);
      const runner: ReplRunner = ({ objective, signal }) =>
        orchestrator.run({ companyId, objective, trigger: "manual", signal });

      const engine = new ReplEngine({
        theme,
        config,
        store,
        companyId,
        runner,
        traces: new InMemoryTraceStore(),
        degraded,
        width,
        write: writeLine,
        exit,
        tools: [...tools.adapters.map((adapter) => ({ name: adapter.name, scopes: adapter.scopes })), ...fleetMemoryToolListing(fleetMemory)],
        sandbox: tools.sandbox,
        egress: tools.egress,
        onApprovalAnswer: bindApprovalAnswers(orchestrator),
      });

      if (!durable) {
        writeLine(
          theme.needsApproval(
            "This session is not durable: the SQLite store needs Bun. Approvals will not survive a restart.",
          ),
        );
      }

      await this.#drive(engine);
    } finally {
      // A throw or stdin ending: release now. After Ctrl+C the exit path already owns the cleanup.
      await (exiting ?? tools.cleanup());
    }
  }

  /**
   * Raw mode and the Kitty flag stack, both restored on the way out — including on a
   * throw. Ctrl+C is a key here, not a signal: raw mode clears ISIG, so the kernel path
   * never fires.
   */
  async #drive(engine: ReplEngine): Promise<void> {
    const io = this.#io;
    const stdin = io.stdin;
    const terminal = { write: (text: string) => io.write(text), isTTY: io.isTTY };
    await withKittyProtocol(terminal, async () => {
      await withRawMode(canUseRawMode(stdin) ? stdin : undefined, async () => {
        stdin.setEncoding("utf8");
        await engine.start();

        let escapeTimer: NodeJS.Timeout | undefined;
        const onData = (chunk: Buffer | string): void => {
          if (escapeTimer !== undefined) clearTimeout(escapeTimer);
          engine.feed(String(chunk));
          escapeTimer = setTimeout(() => engine.flushKeys(), ESCAPE_TIMEOUT_MS);
          escapeTimer.unref?.();
        };

        stdin.on("data", onData);
        stdin.resume?.();
        try {
          await new Promise<void>((resolve) => {
            stdin.once("end", () => resolve());
            stdin.once("close", () => resolve());
          });
        } finally {
          stdin.off("data", onData);
          if (escapeTimer !== undefined) clearTimeout(escapeTimer);
        }
      });
    });
  }
}
