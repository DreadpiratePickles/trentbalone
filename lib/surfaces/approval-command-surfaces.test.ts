import { describe, expect, it } from "vitest";
import {
  createDiscordApprovalPreview,
  createEmailApprovalToken,
  createSlackApprovalPreview,
  createSmsApprovalCommand,
  createTeamsApprovalPreview,
} from "./approval-surfaces";
import {
  createBrowserExtensionManifest,
  createLauncherPluginManifest,
  parseVoiceCommand,
} from "./command-surfaces";

describe("approval and command surfaces", () => {
  it("creates rich Slack, Teams, and Discord approval previews", () => {
    const input = { approvalId: "approval_1", title: "Approve deploy", summary: "Deploy preview is ready", previewUrl: "https://preview.test" };
    expect(createSlackApprovalPreview(input).blocks[0].text).toContain("Approve deploy");
    expect(createTeamsApprovalPreview(input).actions).toContain("approve");
    expect(createDiscordApprovalPreview(input).embeds[0].url).toBe("https://preview.test");
  });

  it("creates email and SMS approval interfaces", () => {
    const email = createEmailApprovalToken({ approvalId: "approval_1", recipient: "founder@example.test" });
    const sms = createSmsApprovalCommand({ approvalId: "approval_1", action: "approve" });
    expect(email.replyToAddress).toContain("approval_1");
    expect(sms.body).toBe("APPROVE approval_1");
  });

  it("parses voice commands and declares browser/Raycast/Alfred command surfaces", () => {
    expect(parseVoiceCommand("approve approval_1").intent).toBe("approve");
    const browserManifest = createBrowserExtensionManifest();
    expect(browserManifest.contextMenus).toContain("Have Trent handle this");
    expect(browserManifest.permissions).toContain("activeTab");
    expect(browserManifest.tools).toContain("steel_screenshot");

    const raycast = createLauncherPluginManifest("raycast");
    expect(raycast.commands[0].name).toBe("Ask Trent");
    expect(raycast.commands.map((command) => command.name)).toContain("Open Steel Browser");
    expect(createLauncherPluginManifest("alfred").bundleId).toContain("alfred");
  });
});
