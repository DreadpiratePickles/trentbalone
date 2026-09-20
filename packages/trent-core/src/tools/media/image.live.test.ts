/**
 * The one live proof for `media_image`: ONE small 1:1 image from the default Gemini image model
 * on Bobby's key, through the same adapter the seat uses, with the approval lifted by the
 * threshold (the standard test proves the ask) and the cost on a ledger in a temporary profile.
 * Gated by TRENT_TEST_LIVE=1; the key comes from GEMINI_API_KEY or <repo>/gem.env and is never
 * printed. Costs the model's row of GEMINI_IMAGE_PRICE_CENTS per run (7 cents on the default).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installSpendLedger, openSpendLedger } from "../../governance/spend-ledger.js";
import { sniffImage } from "../vision/image-source.js";
import { DEFAULT_GEMINI_IMAGE_MODEL, GEMINI_IMAGE_PRICE_CENTS } from "./image.js";
import { createMediaAdapter } from "./index.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of fs.readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
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

const GEMINI_API_KEY = readGeminiKey();
if (!GEMINI_API_KEY) console.error("[media_image.live] SKIPPED: no GEMINI_API_KEY (env or <repo>/gem.env). A skip is NOT a pass.");

describe.skipIf(!GEMINI_API_KEY)("media_image (live, google gemini image model)", () => {
  let root = "";
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-media-image-live-"));
    fs.mkdirSync(path.join(root, "repo"), { recursive: true });
    fs.mkdirSync(path.join(root, "profile"), { recursive: true });
  });
  afterAll(() => {
    installSpendLedger(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("generates one small image, writes it under the workspace and records its price on the ledger", async () => {
    const workspace = path.join(root, "repo");
    const profileDir = path.join(root, "profile");
    const ledger = openSpendLedger({ profileDir });
    installSpendLedger(ledger);
    // TRENT_LIVE_IMAGE_MODEL picks another row of the shipped table when the default's quota is exhausted on this key.
    const model = process.env.TRENT_LIVE_IMAGE_MODEL?.trim() || DEFAULT_GEMINI_IMAGE_MODEL;
    const price = GEMINI_IMAGE_PRICE_CENTS[model]!;
    const adapter = createMediaAdapter(
      { workspace, profileDir, backend: "local" },
      {
        env: { PATH: process.env.PATH ?? "", HOME: root, GEMINI_API_KEY },
        media: { backend: "host", hosted_transcription: false, whisper_model: "", image_provider: "google", image_model: model, image_price_cents: 0, image_auto_approve_under_cents: price + 1 },
      },
    );
    const result = await adapter.execute('media_image {"prompt":"A single solid red circle centred on a plain white background, flat, no text, no shadow.","aspect":"1:1"}', {});
    expect(result.status, result.summary).toBe("completed");
    expect(result.summary).not.toContain(GEMINI_API_KEY);
    const rel = result.summary.split(":")[0]!;
    expect(rel.startsWith("media-out/")).toBe(true);
    const bytes = fs.readFileSync(path.join(workspace, rel));
    expect(bytes.length).toBeGreaterThan(1000);
    expect(sniffImage(bytes)).not.toBeNull();
    const rows = ledger.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: "tool", tool: "media_image", provider: "google", model, cents: price, units: 1 });
    console.error(`[media_image.live] ${rel}: ${bytes.length} bytes ${sniffImage(bytes)}; ${price} cents recorded`);
  }, 120_000);
});
