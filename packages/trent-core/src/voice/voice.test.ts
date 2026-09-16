import { describe, it, expect } from "vitest";
import { EXIT, isTrentError } from "../errors/index.js";
import { transcribeVoice, VOICE_OPERATION } from "./index.js";

/**
 * T0.5 — voice transcription has no implementation in this release. The only thing the module
 * may do is refuse honestly: a TrentError, never a string that looks like a transcript.
 */
describe("transcribeVoice", () => {
  it("throws a TrentError instead of returning transcript-shaped text", () => {
    let thrown: unknown;
    try {
      transcribeVoice(new Uint8Array([1, 2, 3]));
    } catch (err) {
      thrown = err;
    }
    expect(isTrentError(thrown)).toBe(true);
    if (!isTrentError(thrown)) return;
    expect(thrown.code).toBe(EXIT.USAGE);
    expect(thrown.operation).toBe(VOICE_OPERATION);
    expect(thrown.message).toContain("not available in this release");
    expect(thrown.message).not.toMatch(/transcribed/i);
  });
});
