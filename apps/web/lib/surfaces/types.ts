export type SurfaceId =
  | "web_app"
  | "mobile_app"
  | "slack"
  | "microsoft_teams"
  | "discord"
  | "email_interface"
  | "sms_interface"
  | "voice_interface"
  | "browser_extension"
  | "raycast"
  | "alfred"
  | "public_api"
  | "mcp_server";

export type SurfaceStatus = "code_ready" | "external_setup_required";

export type SurfaceCapability = {
  id: SurfaceId;
  name: string;
  status: SurfaceStatus;
  capabilities: string[];
  externalSetup: string[];
};
