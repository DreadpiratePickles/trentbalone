import type { SurfaceCapability } from "./types";

export function buildSurfaceRegistry(): SurfaceCapability[] {
  return [
    surface("web_app", "Web App", "code_ready", ["real_data_dashboard", "approval_console", "workbench"]),
    surface("mobile_app", "Mobile App", "external_setup_required", ["push_approvals", "voice_command"], ["Expo/EAS project", "Apple/Google store accounts"]),
    surface("slack", "Slack", "external_setup_required", ["slash_command", "approval_blocks", "rich_previews"], ["Slack app registration", "OAuth client secret"]),
    surface("microsoft_teams", "Microsoft Teams", "external_setup_required", ["bot_command", "adaptive_cards"], ["Azure bot registration", "Teams app manifest"]),
    surface("discord", "Discord", "external_setup_required", ["slash_command", "approval_embeds"], ["Discord application registration"]),
    surface("email_interface", "Email Interface", "external_setup_required", ["reply_approval", "threaded_actions"], ["Inbound email route", "provider signing secret"]),
    surface("sms_interface", "SMS Interface", "external_setup_required", ["text_approval", "keyword_actions"], ["Twilio number", "A2P registration"]),
    surface("voice_interface", "Voice Interface", "external_setup_required", ["spoken_approvals", "ivr"], ["Voice provider API key"]),
    surface("browser_extension", "Browser Extension", "external_setup_required", ["context_menu", "page_context"], ["Chrome/Firefox store packaging"]),
    surface("raycast", "Raycast", "code_ready", ["command_palette", "approval_actions"]),
    surface("alfred", "Alfred", "code_ready", ["workflow_command", "approval_actions"]),
    surface("public_api", "Public API", "code_ready", ["scoped_tokens", "webhooks"]),
    surface("mcp_server", "MCP Server", "code_ready", ["ide_context", "approval_tools"]),
  ];
}

function surface(
  id: SurfaceCapability["id"],
  name: string,
  status: SurfaceCapability["status"],
  capabilities: string[],
  externalSetup: string[] = []
): SurfaceCapability {
  return { id, name, status, capabilities, externalSetup };
}
