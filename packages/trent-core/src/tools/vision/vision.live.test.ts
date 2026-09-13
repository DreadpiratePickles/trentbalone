/**
 * The one live proof for `vision_analyze`: a generated PNG (a solid red square) is sent to the
 * configured Gemini model through the real model gateway's OpenAI-compatible path as an
 * `image_url` data URI, and the reply must name the colour. Gated by TRENT_TEST_LIVE=1; the key
 * comes from GEMINI_API_KEY or <repo>/gem.env and is never printed.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createModelGateway } from "../../model-gateway/index.js";
import { createVisionAdapter } from "./index.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const LIVE_MODEL = "gemini-3.5-flash-lite";

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      if (match) {
        const value = match[1]!.trim().replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** A 32x32 solid red PNG built by hand so the test ships no binary fixture. */
function redSquarePng(size = 32): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf: Buffer): number => {
    let c = -1;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const GEMINI_API_KEY = readGeminiKey();
if (!GEMINI_API_KEY) console.error("[vision.live] SKIPPED: no GEMINI_API_KEY (env or <repo>/gem.env). A skip is NOT a pass.");

describe.skipIf(!GEMINI_API_KEY)("vision_analyze (live, google/gemini)", () => {
  it("sends a red square as an image_url data URI and the model names the colour", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: GEMINI_API_KEY! },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: LIVE_MODEL },
    });
    const workspace = mkdtempSync(path.join(os.tmpdir(), "trent-vision-live-"));
    const file = path.join(workspace, "red.png");
    writeFileSync(file, redSquarePng());
    try {
      const adapter = createVisionAdapter({ workspace, profileDir: workspace, gateway });
      const result = await adapter.execute(
        `vision_analyze {"image_path":"${file}","question":"In one word, what colour is this image?"}`,
        {},
      );
      expect(result.status, result.summary).toBe("completed");
      expect(result.summary.toLowerCase()).toContain("red");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
