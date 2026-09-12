export function parseVoiceCommand(command: string) {
  const [verb, target] = command.trim().toLowerCase().split(/\s+/);
  return {
    intent: verb === "approve" || verb === "reject" ? verb : "unknown",
    target,
  };
}

export function createBrowserExtensionManifest() {
  return {
    manifestVersion: 3,
    name: "Trent",
    contextMenus: ["Have Trent handle this"],
    permissions: ["contextMenus", "activeTab", "storage"],
    tools: [
      "steel_scrape",
      "steel_screenshot",
      "steel_pdf",
      "steel_sessions",
    ],
  };
}

export function createLauncherPluginManifest(kind: "raycast" | "alfred") {
  return {
    kind,
    bundleId: `com.trent.${kind}`,
    commands: [
      { name: "Ask Trent", mode: "view" },
      { name: "Open Steel Browser", mode: "view" },
      { name: "Capture Steel Screenshot", mode: "action" },
      { name: "Approve Trent Action", mode: "action" },
    ],
  };
}
