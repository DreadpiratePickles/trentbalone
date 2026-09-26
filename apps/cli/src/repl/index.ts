/**
 * The classic REPL, wired to the real thing.
 *
 * Everything the user types goes to `createOrchestrator()`, which streams real events
 * from the real 20-kind bus over the real model gateway. There is no canned reply path
 * in this file or in any file it imports; `__tests__/no-canned.test.ts` enforces that.
 */

import process from "node:process";
import { ConfigManager, FleetManager, PersonalityManager, SessionManager, SkillsHub } from "@trent/core";
import type { createOrchestrator as createRealOrchestrator } from "@trent/core/orchestrator/index.js";
import { createModelGateway } from "@trent/core/model-gateway/index.js";
import { InMemoryTraceStore } from "@trent/core/traces/index.js";
import { acquireProfileWriter } from "@trent/core/profile/locks.js";
import { diagnoseStoreFailure } from "@trent/core/store/durability.js";
import { autoTheme, canUseRawMode, terminalWidth, type Theme } from "../ui/index.js";
import { playBoot, type BootStdin } from "../ui/boot.js";
import { ReplEngine, bindApprovalAnswers, type ReplRunner } from "./engine.js";
import { Conversation, historyLimits, historySeed, recapLines, sessionSink } from "./conversation.js";
import { contextLimits, createSessionCompactor } from "./compact.js";
import { degradedState } from "./degraded.js";
import { ESCAPE_TIMEOUT_MS, withKittyProtocol } from "./keys.js";
import { withRawMode } from "./interrupt.js";
import { toolsStatusLine, type ToolWiringDeps } from "./tools.js";
import { fleetMemoryToolListing } from "./fleet-memory.js";
import { workspaceNotices } from "./workspace.js";
import { createHeadlessRuntime } from "../runtime/headless.js";
import { resolveAgentMode, type AgentMode, type SoloSeams } from "../runtime/runner-for-mode.js"; // [S2]
import { replContinuity } from "./solo-commands.js"; // [S3]
import type { ReplConfig } from "./types.js";

/**
 * The two callbacks the conversation needs but the runtime owns. `#openConversation` runs before
 * the object graph exists (a resumed session's recap belongs on screen whether or not the store
 * comes up), so the session id and the after-turn compaction are filled in afterwards.
 */
interface TurnHooks {
  sessionId?: () => string | undefined;
  /** [S2] The session id, created on first use: a solo run needs its conversation before it starts. */
  resolveSessionId?: () => string;
  afterAssistant?: () => void;
}

export { ReplEngine, bindApprovalAnswers } from "./engine.js";
export { TranscriptRenderer, renderTranscript, identityForRole } from "./render.js";
export { BudgetLedger, formatCents } from "./budget.js";
export {
  Conversation,
  DEFAULT_HISTORY_CHARS,
  DEFAULT_HISTORY_TURNS,
  historyLimits,
  recapLines,
  trimHistory,
} from "./conversation.js";
export type { HistoryMessage, TurnMetadata } from "./conversation.js";
export { ApprovalGate, renderApprovalCard } from "./approvals.js";
export { REPL_COMMANDS, runCommand, commandNames } from "./commands.js";
export { isDegraded, renderDegradedBanner } from "./degraded.js";
export { KeyDecoder, NEWLINE_HINT } from "./keys.js";
export { wireTools, toolsStatusLine, startEgressProxy, probeDockerCli, FLOOR_IMAGE } from "./tools.js";
export { wireFleetMemory, fleetMemoryToolListing } from "./fleet-memory.js";
export type { FleetMemoryWiringDeps } from "./fleet-memory.js";
export { renderWorkspaceContext, workspaceNotices } from "./workspace.js";
export { ContextTracker, contextReport, contextReportLines, contextStatusLine, NO_CONTEXT_LINE } from "./context-report.js";
export type { ContextReport, ContextSeatReport } from "./context-report.js";
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
  /** [S2] Solo's test seams: a scripted model and a recording audit writer. */
  solo?: SoloSeams;
}

export interface ReplOptions {
  continueSession?: boolean;
  profile?: string;
  /** [S2] A launch override of `agent.mode` (`trent solo`, `trent --solo`). */
  mode?: AgentMode;
  io?: ReplIo;
  deps?: ReplDeps;
}

function processIo(): ReplIo {
  return {
    write: (text) => void process.stdout.write(text),
    isTTY: process.stdout.isTTY === true,
    stdin: process.stdin as unknown as ReplStdin,
    exit: (code) => process.exit(code),
  };
}

export class ClassicRepl {
  readonly #configManager: ConfigManager;
  readonly #sessions: SessionManager;
  readonly #io: ReplIo;
  readonly #deps: ReplDeps;
  readonly #continue: boolean;
  readonly #mode: AgentMode | undefined; // [S2]

  constructor(options: ReplOptions = {}) {
    this.#mode = options.mode; // [S2]
    this.#configManager = new ConfigManager({ profile: options.profile });
    this.#sessions = new SessionManager(this.#configManager);
    this.#io = options.io ?? processIo();
    this.#deps = options.deps ?? {};
    this.#continue = options.continueSession === true;
  }

  /**
   * The transcript this session runs on: the profile's last session when `--continue` restored
   * one, a new one on the first turn otherwise. The session file is the durable copy; the
   * `Conversation` is what the next run is told, bounded by `historyLimits`.
   */
  #openConversation(config: ReplConfig, write: (line: string) => void, width: number, theme: Theme, turns: TurnHooks, solo = false): {
    conversation: Conversation;
    openingCents: number;
  } {
    const resumed = this.#continue ? this.#sessions.resumeLastSession() : null;
    if (resumed !== null) for (const line of recapLines(resumed, width)) write(theme.meta(line));
    const agent = config.fleet.default_agent;
    let sessionId = resumed?.id;
    const seed = historySeed(resumed?.messages ?? []);
    const resolveSessionId = (): string => (sessionId ??= this.#sessions.startSession(agent, config.model, config.provider).id);
    turns.sessionId = () => sessionId;
    turns.resolveSessionId = resolveSessionId; // [S2]
    const sink = sessionSink(this.#sessions, resolveSessionId, agent);
    return {
      conversation: new Conversation({
        ...historyLimits(config),
        seed,
        // Compaction runs after the turn is durable, never before: the transcript on disk is the
        // thing being compacted, and a crash mid-turn must leave the whole turn, not half of one.
        // [S2] In solo the runner is the session's ONLY writer (council A1), so the REPL keeps no
        // sink: nothing is written twice, and the fleet's compaction never touches a solo session.
        ...(solo
          ? {}
          : {
              sink: {
                user: sink.user,
                assistant: (content: string, metadata: Parameters<typeof sink.assistant>[1]) => {
                  sink.assistant(content, metadata);
                  turns.afterAssistant?.();
                },
              },
            }),
      }),
      openingCents: resumed?.total_cost_cents ?? 0,
    };
  }

  async start(): Promise<void> {
    const io = this.#io;
    const theme = io.theme ?? autoTheme();
    const config = this.#configManager.loadConfig() as unknown as ReplConfig;
    // Parses the profile's .env AND exports every key into process.env, which is where the
    // gateway reads them. Values are never read here.
    const secrets = this.#configManager.loadSecrets() as unknown as Record<string, string | undefined>;
    // [L0-3] G7: a hosted provider is degraded without a key; a local one when its runtime is down.
    const { degraded, notice: degradedNotice } = await degradedState({ source: { ...process.env, ...secrets }, provider: config.provider, model: config.model });
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
    // A live writer on the profile from here to exit, before the transcript is first written, so
    // `trent sessions prune` and the other maintenance commands refuse while this session is up.
    const releaseWriter = acquireProfileWriter(this.#configManager.getProfileDir(), "repl");

    // The conversation before the object graph: a resumed session's recap belongs on screen
    // whether or not the store, the proxy or the sandboxes come up.
    // The compactor is installed once the runtime exists (it needs the shared memory adapter), so
    // the conversation is handed a holder it calls after every persisted answer.
    const turns: TurnHooks = {};
    const mode = resolveAgentMode(config as { agent?: { mode?: AgentMode } }, this.#mode); // [S2] before the conversation: it decides who writes it
    const { conversation, openingCents } = this.#openConversation(config, writeLine, width, theme, turns, mode === "solo");

    // The session's object graph — store, tools, fleet memory, the improve loop, the orchestrator
    // and the company — is the same one the gateway and the schedulers run on; only the terminal
    // is this file's own. Everything the runtime holds is released by `runtime.cleanup()` on
    // every exit path: stdin end, a throw, and Ctrl+C.
    const runtime = await createHeadlessRuntime({
      configManager: this.#configManager,
      config,
      // [G3.1] Everything this session spends goes on the day's ledger as the REPL's.
      surface: "repl",
      workspace: this.#deps.workspace,
      createOrchestrator: this.#deps.createOrchestrator,
      buildAdapters: this.#deps.buildAdapters,
      startEgress: this.#deps.startEgress,
      probeDocker: this.#deps.probeDocker,
      // [S2] The mode this launch resolved; a held call parks, because a human is at this terminal.
      mode,
      holds: "park",
      ...(this.#deps.solo === undefined ? {} : { solo: this.#deps.solo }),
    }).catch((error: unknown) => {
      releaseWriter();
      throw error;
    });
    const { tools, store, durable, fleetMemory, companyId } = runtime; // [S2] approvals go to runtime.runner, not the orchestrator
    writeLine(toolsStatusLine(tools, theme));
    writeLine(theme.meta(runtime.runner.label)); // [S2] the banner names the mode and the model

    // A2.1. The workspace's instruction files are already in the stable tier if they were loaded;
    // what belongs on screen is what was NOT: an untrusted root, and every refused file by name.
    for (const [index, line] of workspaceNotices(runtime.workspace).entries()) {
      writeLine(index === 0 && !runtime.workspace.trusted ? theme.needsApproval(line) : theme.meta(line));
    }

    // Session compaction (docs/configuration.md, "Context management"): once the stored transcript
    // passes `context.compact_after_chars` the turns about to be dropped are offered to the shared
    // memory, summarised into one message, and one compaction event records what was forgotten.
    // The gateway is built on demand, so a session that never crosses the threshold never makes one.
    const compactor = createSessionCompactor({
      sessions: this.#sessions,
      companyId,
      limits: contextLimits(config),
      memory: fleetMemory.memory,
      gateway: async () => createModelGateway(),
    });
    // `/context` reports how often this session's transcript has been compacted; the compactor is
    // the only thing that can say, so it counts as it goes.
    let compactions = 0;
    turns.afterAssistant = () => {
      const id = turns.sessionId?.();
      if (id === undefined) return;
      void compactor(id).then((outcome) => {
        if (outcome.status !== "compacted") return;
        compactions += 1;
        const record = outcome.event.metadata?.compaction;
        const reclaimed = record === undefined ? 0 : record.chars_before - record.chars_after;
        writeLine(theme.meta(`Compacted this session: ${outcome.forgotten.length} message(s) summarised, ${reclaimed} chars reclaimed.`));
      }, () => undefined);
    };

    // [S3] /compact (the fleet's compactor or the solo runner), and in solo: a park this session left behind is
    // offered now, `/resume` runs it as a turn, and a `/rollback` is told to the conversation (./solo-commands.ts).
    const continuity = replContinuity(runtime.runner, () => turns.sessionId?.(), compactor);
    for (const line of continuity.offers()) writeLine(theme.needsApproval(line));

    let exiting: Promise<void> | undefined;
    const exit = (code: number): void => {
      // Ctrl+C is a key here (raw mode), so the proxy and the sandboxes are stopped BEFORE the
      // process goes; `process.exit` would otherwise leave the listener and the containers behind.
      exiting ??= runtime.cleanup().finally(() => {
        releaseWriter();
        io.exit(code);
      });
    };

    try {
      // [S2] Solo owns the conversation: the run is told the REPL's session and never its history.
      const runner: ReplRunner =
        runtime.mode === "solo"
          ? ({ objective, signal }) => runtime.run(objective, { trigger: "manual", signal, session: (turns.resolveSessionId as () => string)() })
          : ({ objective, signal, history }) => runtime.run(objective, { trigger: "manual", signal, ...(history === undefined ? {} : { history }) });

      // Typed: the `/exit` port below reads `engine.busy` from inside the engine's own options.
      const engine: ReplEngine = new ReplEngine({
        theme,
        config,
        store,
        companyId,
        runner,
        conversation,
        openingCents,
        traces: new InMemoryTraceStore(),
        degraded,
        ...(degradedNotice === undefined ? {} : { degradedNotice }),
        width,
        write: writeLine,
        exit,
        tools: [...tools.adapters.map((adapter) => ({ name: adapter.name, scopes: adapter.scopes })), ...fleetMemoryToolListing(fleetMemory)],
        sandbox: tools.sandbox,
        egress: tools.egress,
        onApprovalAnswer: bindApprovalAnswers(runtime.runner), // [S2] the runner by mode is the approval target
        ...(continuity.resume === undefined ? {} : { resume: continuity.resume }), // [S3]
        // `/context` measures the assembly the hook performed; it estimates nothing of its own.
        contextInspector: fleetMemory,
        compactions: () => compactions,
        // A2.2: a hook that did not run, said once, after the turn during which it was skipped.
        notices: () => runtime.notices(),
        ports: {
          fleet: new FleetManager(this.#configManager),
          skills: new SkillsHub(this.#configManager),
          personalities: new PersonalityManager(this.#configManager),
          sessions: this.#sessions,
          // `/exit` is Ctrl+D as a command: the same `exit(0)`, and refused mid-run as Ctrl+D is.
          session: { end: () => (engine.busy ? "busy" : (exit(0), "ended")) },
          ...continuity.ports, // [S3]
        },
      });

      if (!durable) {
        // Bun under Node; under Bun, the generated client or the database (store/durability.ts).
        const why = await diagnoseStoreFailure();
        writeLine(theme.needsApproval(`This session is not durable: ${why.reason}. Approvals will not survive a restart.`));
      }

      await this.#drive(engine);
    } finally {
      // A throw or stdin ending: release now. After Ctrl+C the exit path already owns the cleanup.
      await (exiting ?? runtime.cleanup());
      releaseWriter();
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
