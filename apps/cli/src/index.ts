#!/usr/bin/env node
/**
 * The `trent` binary.
 *
 * The only place in the CLI that touches `process.exit`. Everything else returns an exit code, which
 * is what makes the whole command surface testable in-process.
 *
 * Exit codes: 0 ok, 2 usage, 3 config, 4 auth, 5 provider, 6 budget, 130 interrupt.
 */

import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "./commands/index.js";

let interrupted = false;

process.on("SIGINT", () => {
  if (interrupted) process.exit(EXIT.INTERRUPT);
  interrupted = true;
  process.exit(EXIT.INTERRUPT);
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
