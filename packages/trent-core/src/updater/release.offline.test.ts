/**
 * [SEC-2 S2b-2 / gap 1] The updater dials GitHub over node:https, which trentFetch cannot wrap.
 * Offline mode refuses the release host directly, before any socket is opened.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { resolveLatest, fetchArtifact } from "./release.js";

const saved = process.env.TRENT_OFFLINE;
beforeEach(() => {
  delete process.env.TRENT_OFFLINE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.TRENT_OFFLINE;
  else process.env.TRENT_OFFLINE = saved;
});

describe("updater release — offline refusal", () => {
  it("refuses to resolve the latest release while offline (no dial to api.github.com)", async () => {
    process.env.TRENT_OFFLINE = "1";
    await expect(resolveLatest("stable")).rejects.toThrow(/offline mode: refusing to contact api\.github\.com/i);
  });

  it("refuses to fetch an artifact while offline", async () => {
    process.env.TRENT_OFFLINE = "1";
    await expect(fetchArtifact("trent-macos-arm64.tar.gz", "1.2.3")).rejects.toThrow(/offline mode: refusing to contact github\.com/i);
  });
});
