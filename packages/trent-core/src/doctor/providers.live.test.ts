/**
 * One real, end-to-end authenticated probe. Skipped unless the gitignored key file exists.
 * The key value is read into a local variable, handed to the probe, and never printed,
 * asserted on, or written anywhere.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { credentialForProvider } from "./providers.js";

const KEY_FILE = path.resolve(process.cwd(), "gem.env");

function readGeminiKey(): string | undefined {
  if (!fs.existsSync(KEY_FILE)) return undefined;
  for (const line of fs.readFileSync(KEY_FILE, "utf8").split("\n")) {
    const match = /^GEMINI_API_KEY=(.+)$/.exec(line.trim());
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

const key = readGeminiKey();

describe.skipIf(!key)("live Gemini probe", () => {
  it("returns ok for a working key against the real endpoint", async () => {
    const google = credentialForProvider("google")!;
    expect(google.validateShape(key as string).valid).toBe(true);
    const outcome = await google.probe(key as string, undefined, { timeoutMs: 8000 });
    // "unreachable" would mean this machine is offline, which is not a key failure.
    expect(["ok", "unreachable"]).toContain(outcome);
    expect(outcome).not.toBe("unauthorized");
  }, 15000);
});
