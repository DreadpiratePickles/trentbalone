/**
 * [H2] RED — the doctor's MCP line names an OAuth-managed server whose token needs a person (expired with
 * no refresh token, or never logged in) and the command that fixes it, and never prints a token.
 * A token that renews itself on the next connect is not a finding.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { mcpOAuthHeaderTemplate } from "../../tools/mcp/http-oauth-store.js";
import type { DoctorContext } from "../types.js";
import { checkMcp } from "./mcp.js";

let home: string;
let manager: ConfigManager;

const context = (): DoctorContext => ({ baseDir: home, profile: "default", configManager: manager, probeTimeoutMs: 200 });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-mcp-"));
  manager = new ConfigManager({ baseDir: home });
  manager.ensureDirs();
  manager.set("mcp_servers.remote", { transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: mcpOAuthHeaderTemplate("remote") }, auto_approve: [], enabled: true });
});

afterEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith("MCP_REMOTE_")) delete process.env[name];
  fs.rmSync(home, { recursive: true, force: true });
});

describe("mcp check: OAuth tokens", () => {
  it("names an expired token that cannot renew, and the login command", async () => {
    manager.saveSecrets({ MCP_REMOTE_ACCESS_TOKEN: "expired-access-fixture", MCP_REMOTE_TOKEN_EXPIRES_AT: "2020-01-01T00:00:00.000Z" });
    const result = await checkMcp.run(context());
    expect(result.status).toBe("warn");
    expect(result.message).toContain("remote");
    expect(result.message).toContain("expired at 2020-01-01T00:00:00.000Z");
    expect(result.fixHint).toContain("trent mcp test remote --oauth");
    expect(JSON.stringify(result)).not.toContain("expired-access-fixture");
  });

  it("names an OAuth server nobody has logged in to", async () => {
    const result = await checkMcp.run(context());
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/remote.*never logged in/);
    expect(result.fixHint).toContain("trent mcp test remote --oauth");
  });

  it("says nothing about a token that renews itself on the next connect", async () => {
    manager.saveSecrets({
      MCP_REMOTE_ACCESS_TOKEN: "old-access-fixture",
      MCP_REMOTE_REFRESH_TOKEN: "refresh-fixture",
      MCP_REMOTE_TOKEN_EXPIRES_AT: "2020-01-01T00:00:00.000Z",
      MCP_REMOTE_OAUTH_CLIENT_ID: "client-fixture",
      MCP_REMOTE_OAUTH_ISSUER: "https://auth.example.com",
      MCP_REMOTE_OAUTH_TOKEN_URL: "https://auth.example.com/token",
      MCP_REMOTE_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
      MCP_REMOTE_OAUTH_REDIRECT_URI: "http://127.0.0.1:40000/callback",
    });
    const result = await checkMcp.run(context());
    expect(result.status).not.toBe("warn");
    expect(result.message).not.toMatch(/expired|logged in/);
  });
});
