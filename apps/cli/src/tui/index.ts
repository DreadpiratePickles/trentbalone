import React from "react";
import { render } from "ink";
import process from "node:process";
import { ConfigManager, FleetManager, SessionManager, ApprovalBridge } from "@trent/core";
import { createOrchestrator } from "@trent/core/orchestrator/index.js";
import { loadWorkspaceContext } from "@trent/core/workspace-context/index.js";
import { contextLimits, personalitySuffix } from "../repl/compact.js";
import { wireFleetMemory } from "../repl/fleet-memory.js";
import { renderWorkspaceContext } from "../repl/workspace.js";
import type { ReplConfig } from "../repl/types.js";
import { App } from "./App.js";

export async function runTui(options?: { profile?: string }): Promise<void> {
  const configManager = new ConfigManager({ profile: options?.profile });
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

  const appInstance = render(
    React.createElement(App, {
      configManager,
      fleetManager,
      sessionManager,
      approvalBridge,
      orchestrator: createOrchestrator({ fleetMemory }),
      contextInspector: fleetMemory,
    })
  );

  await appInstance.waitUntilExit();
}

export * from "./App.js";
export * from "./Sidebar.js";
export * from "./Chat.js";
export * from "./Activity.js";
export * from "./ContextPane.js";
