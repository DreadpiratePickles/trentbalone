import React from "react";
import { render } from "ink";
import { ConfigManager, FleetManager, SessionManager, ApprovalBridge } from "@trent/core";
import { App } from "./App.js";

export async function runTui(options?: { profile?: string }): Promise<void> {
  const configManager = new ConfigManager({ profile: options?.profile });
  const fleetManager = new FleetManager(configManager);
  const sessionManager = new SessionManager(configManager);
  const approvalBridge = new ApprovalBridge();

  const appInstance = render(
    React.createElement(App, {
      configManager,
      fleetManager,
      sessionManager,
      approvalBridge,
    })
  );

  await appInstance.waitUntilExit();
}

export * from "./App.js";
export * from "./Sidebar.js";
export * from "./Chat.js";
export * from "./Activity.js";
