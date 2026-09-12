/**
 * The classic REPL, wired to the real thing.
 *
 * Everything the user types goes to `createOrchestrator()`, which streams real events
 * from the real 20-kind bus over the real model gateway. There is no canned reply path
 * in this file or in any file it imports; `__tests__/no-canned.test.ts` enforces that.
 */

import process from "node:process";
import { ConfigManager, SessionManager } from "@trent/core";
import { createOrchestrator } from "@trent/core/orchestrator/index.js";
import { InMemoryTraceStore } from "@trent/core/traces/index.js";
import { autoTheme, canUseRawMode, terminalWidth, renderBanner } from "../ui/index.js";
import { ReplEngine, type ReplRunner } from "./engine.js";
import { EphemeralStore } from "./ephemeral-store.js";
import { isDegraded } from "./degraded.js";
import { ESCAPE_TIMEOUT_MS, withKittyProtocol } from "./keys.js";
import { withRawMode } from "./interrupt.js";
import type { ReplConfig, ReplStore } from "./types.js";

export { ReplEngine } from "./engine.js";
export { TranscriptRenderer, renderTranscript, identityForRole } from "./render.js";
export { BudgetLedger, formatCents } from "./budget.js";
export { ApprovalGate, renderApprovalCard } from "./approvals.js";
export { REPL_COMMANDS, runCommand, commandNames } from "./commands.js";
export { isDegraded, renderDegradedBanner } from "./degraded.js";
export { KeyDecoder, NEWLINE_HINT } from "./keys.js";
export type { ReplContext, ReplStore } from "./types.js";

export interface ReplOptions {
  continueSession?: boolean;
  profile?: string;
}

const DEFAULT_COMPANY_ID = "trent-local";

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

  constructor(options: ReplOptions = {}) {
    this.#configManager = new ConfigManager({ profile: options.profile });
    this.#sessions = new SessionManager(this.#configManager);
    if (options.continueSession === true) this.#sessions.resumeLastSession();
  }

  async start(): Promise<void> {
    const theme = autoTheme();
    const config = this.#configManager.loadConfig() as unknown as ReplConfig;
    const secrets = this.#configManager.loadSecrets() as unknown as Record<string, string | undefined>;
    const degraded = isDegraded({ ...process.env, ...secrets });
    const width = terminalWidth();

    const companyId = String((config as { company?: { id?: string } }).company?.id ?? DEFAULT_COMPANY_ID);
    const databaseUrl = `file:${this.#configManager.getProfileDir()}/trent.db`;
    const { store, durable } = await openStore(databaseUrl);

    const orchestrator = createOrchestrator(durable ? { databaseUrl } : {});
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
      write: (line) => process.stdout.write(`${line}\n`),
      exit: (code) => process.exit(code),
      onApprovalAnswer: async (stepId, answer) => {
        if (stepId === undefined) return;
        const runId = engine.context.runIds?.at(-1);
        if (runId === undefined) return;
        if (answer === "approved") await orchestrator.approve(runId, stepId);
        else await orchestrator.reject(runId, stepId);
      },
    });

    for (const line of renderBanner("repl", width, theme)) process.stdout.write(`${line}\n`);
    if (!durable) {
      process.stdout.write(
        `${theme.needsApproval(
          "This session is not durable: the SQLite store needs Bun. Approvals will not survive a restart.",
        )}\n`,
      );
    }

    await this.#drive(engine);
  }

  /**
   * Raw mode and the Kitty flag stack, both restored on the way out — including on a
   * throw. Ctrl+C is a key here, not a signal: raw mode clears ISIG, so the kernel path
   * never fires.
   */
  async #drive(engine: ReplEngine): Promise<void> {
    const io = { write: (text: string) => void process.stdout.write(text), isTTY: process.stdout.isTTY === true };
    await withKittyProtocol(io, async () => {
      await withRawMode(canUseRawMode(process.stdin) ? process.stdin : undefined, async () => {
        process.stdin.setEncoding("utf8");
        await engine.start();

        let escapeTimer: NodeJS.Timeout | undefined;
        const onData = (chunk: string): void => {
          if (escapeTimer !== undefined) clearTimeout(escapeTimer);
          engine.feed(chunk);
          escapeTimer = setTimeout(() => engine.flushKeys(), ESCAPE_TIMEOUT_MS);
          escapeTimer.unref?.();
        };

        process.stdin.on("data", onData);
        try {
          await new Promise<void>((resolve) => {
            process.stdin.once("end", () => resolve());
            process.stdin.once("close", () => resolve());
          });
        } finally {
          process.stdin.off("data", onData);
          if (escapeTimer !== undefined) clearTimeout(escapeTimer);
        }
      });
    });
  }
}
