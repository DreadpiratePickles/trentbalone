import React from "react";
import { render, type RenderOptions } from "ink";
import process from "node:process";
import { ConfigManager, FleetManager, SessionManager, ApprovalBridge } from "@trent/core";
import { createOrchestrator } from "@trent/core/orchestrator/index.js";
import { acquireProfileWriter } from "@trent/core/profile/locks.js";
import { loadWorkspaceContext } from "@trent/core/workspace-context/index.js";
import { contextLimits, personalitySuffix } from "../repl/compact.js";
import { wireFleetMemory } from "../repl/fleet-memory.js";
import { renderWorkspaceContext } from "../repl/workspace.js";
import type { ReplConfig } from "../repl/types.js";
import { App } from "./App.js";

export interface TuiOptions {
  profile?: string;
  /** Where Ink renders and reads keys; the process's own terminal when absent. A test passes its own streams. */
  renderOptions?: RenderOptions;
  /** The orchestrator factory; the real in-process one when absent. */
  createOrchestrator?: typeof createOrchestrator;
}

export async function runTui(options: TuiOptions = {}): Promise<void> {
  const configManager = new ConfigManager({ profile: options.profile });
  const fleetManager = new FleetManager(configManager);
  const sessionManager = new SessionManager(configManager);
  const approvalBridge = new ApprovalBridge();

  // The same company memory the classic REPL runs on: the named memory blocks, the workspace's
  // trusted instruction files, cross-agent recall and the personality suffix, all bounded by
  // `context.ceiling_chars`. The hook is also what the context pane measures.
  const config = configManager.loadConfig() as unknown as ReplConfig;
  const profileDir = configManager.getProfileDir();
  const workspace = loadWorkspaceContext({ cwd: process.cwd(), profileDir, config: configManager.loadConfig() });
  const workspaceBlock = renderWorkspaceContext(workspace);
  const suffix = personalitySuffix(configManager);
  const fleetMemory = wireFleetMemory({
    profileDir,
    ceilingChars: contextLimits(config).ceilingChars,
    ...(suffix === undefined ? {} : { personalitySuffix: suffix }),
    ...(workspaceBlock === undefined ? {} : { workspaceContext: workspaceBlock }),
  });

  // [P2-10] A live writer on the profile from before the session is first written to exit, as the
  // REPL is (`../repl/index.ts`), so `trent sessions prune` and the other maintenance commands refuse
  // while it is up. `/exit` and `/quit` unmount the app, so the release below runs before the binary
  // exits 0; any other exit is covered by the lock module's own process `exit` hook.
  const releaseWriter = acquireProfileWriter(profileDir, "tui");
  try {
    const appInstance = render(
      React.createElement(App, {
        configManager,
        fleetManager,
        sessionManager,
        approvalBridge,
        orchestrator: (options.createOrchestrator ?? createOrchestrator)({ fleetMemory }),
        contextInspector: fleetMemory,
      }),
      options.renderOptions,
    );
    await appInstance.waitUntilExit();
  } finally {
    releaseWriter();
  }
}

export * from "./App.js";
export * from "./Sidebar.js";
export * from "./Chat.js";
export * from "./Activity.js";
export * from "./ContextPane.js";
