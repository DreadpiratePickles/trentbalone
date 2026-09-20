/**
 * The business line of `trent doctor`: one line per provider the business toolset executes
 * against (Stripe, Google Calendar, Square, Twilio), connected or not, with the connect command
 * for each one that is not. Never a token: the check reads names and metadata only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { ConnectStore } from "../../connect/store.js";
import { DEFAULT_CHECKS } from "../DoctorRunner.js";
import type { DoctorContext } from "../types.js";
import { BUSINESS_PROVIDERS, checkBusiness } from "./business.js";

const SECRET = "sk_test_never_printed_0123456789";

let root: string;
let configManager: ConfigManager;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-business-"));
  configManager = new ConfigManager({ baseDir: path.join(root, "home") });
  configManager.ensureDirs();
});

afterEach(() => {
  for (const name of Object.keys(process.env)) if (/^(STRIPE|GOOGLE|SQUARE|TWILIO)_/.test(name)) delete process.env[name];
  fs.rmSync(root, { recursive: true, force: true });
});

function context(): DoctorContext {
  return { baseDir: path.join(root, "home"), profile: "default", configManager, env: {}, probeTimeoutMs: 1000 };
}

describe("checkBusiness", () => {
  it("is one of the runner's checks", () => {
    expect(DEFAULT_CHECKS.map((check) => check.id)).toContain("check_business");
  });

  it("with nothing connected it skips, names every provider on its own line, and gives the connect command for each", async () => {
    const result = await checkBusiness.run(context());
    expect(result.status).toBe("skip");
    const lines = result.message.split("\n");
    expect(lines).toHaveLength(BUSINESS_PROVIDERS.length);
    for (const provider of BUSINESS_PROVIDERS) {
      expect(result.message).toMatch(new RegExp(`${provider}.*not connected`, "i"));
      expect(result.fixHint).toContain(`trent connect ${provider}`);
    }
    expect(result.details).toMatchObject({ connected: [], missing: [...BUSINESS_PROVIDERS] });
  });

  it("reports a connected provider as connected on its line, and never prints the key", async () => {
    new ConnectStore(configManager).writeFields("stripe", { STRIPE_SECRET_KEY: SECRET });
    const result = await checkBusiness.run(context());
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/stripe.*connected/i);
    expect(result.message).toMatch(/twilio.*not connected/i);
    expect(result.message).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.details).toMatchObject({ connected: ["stripe"] });
    expect(result.fixHint).not.toContain("trent connect stripe");
    expect(result.fixHint).toContain("trent connect twilio");
  });
});
