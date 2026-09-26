#!/usr/bin/env node
/**
 * The `trent` binary.
 *
 * The only place in the CLI that touches `process.exit` on a command's behalf (a keep-alive command
 * exits through `./signals.ts` once its release settles). Everything else returns an exit code,
 * which is what makes the whole command surface testable in-process.
 *
 * Exit codes: 0 ok, 1 run failed, 2 usage, 3 config, 4 auth, 5 provider, 6 budget,
 * 7 awaiting approval, 130 interrupt.
 */

// FIRST import, on purpose: it sets TRENT_QUEUE_FALLBACK before any other module is evaluated.
import "./env-defaults.js";
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "./commands/index.js";
import { interruptIsOwned } from "./signals.js";

let interrupted = false;

process.on("SIGINT", () => {
  // A long-running command (`trent gateway start`) claims the interrupt so it can release its
  // pid lock, its adapters and its runtime first; exiting here would pre-empt that. A second
  // Ctrl+C means the founder is done waiting and goes immediately.
  if (interrupted || !interruptIsOwned()) process.exit(EXIT.INTERRUPT);
  interrupted = true;
});

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const result = await runCli(argv, { tee: true });

  if (result.launch !== undefined) {
    // An interactive surface owned by other modules; the registry never renders these.
    if (result.launch === "tui") {
      const { runTui } = await import("./tui/index.js");
      await runTui({ profile: profileFrom(argv) });
    } else {
      const { ClassicRepl } = await import("./repl/index.js");
      await new ClassicRepl({
        profile: profileFrom(argv),
        continueSession: argv.includes("-c") || argv.includes("--continue"),
        ...(result.mode === undefined ? {} : { mode: result.mode }), // [S2] `trent solo`, `trent --solo`
      }).start();
    }
    process.exit(EXIT.OK);
  }

  if (result.keepAlive && result.exitCode === EXIT.OK) {
    // A server is listening; the event loop holds the process open until Ctrl+C.
    return;
  }

  process.exit(result.exitCode);
}

function profileFrom(argv: readonly string[]): string {
  const index = argv.findIndex((a) => a === "--profile" || a === "-p");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value ?? process.env.TRENT_PROFILE ?? "default";
}

main().catch((error: unknown) => {
  // runCli already renders every failure it can classify; this is the last resort.
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(EXIT.USAGE);
});
