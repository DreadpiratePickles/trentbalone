import { describe, expect, it } from "vitest";
import { resolveMaxTokens } from "@/lib/ai-client";

describe("MAX_TOKENS env overrides", () => {
  it("uses bounded env overrides when importing token defaults", async () => {
    try {
      process.env.OPENAI_MAX_TOKENS_JSON = "1500";
      process.env.OPENAI_MAX_TOKENS_PROSE = "1200";
      process.env.OPENAI_MAX_TOKENS_CHAT = "1300";
      process.env.OPENAI_MAX_TOKENS_PLANNING = "1400";

      expect(resolveMaxTokens()).toEqual({
        JSON: 1500,
        PROSE: 1200,
        CHAT: 1300,
        PLANNING: 1400,
      });
    } finally {
      delete process.env.OPENAI_MAX_TOKENS_JSON;
      delete process.env.OPENAI_MAX_TOKENS_PROSE;
      delete process.env.OPENAI_MAX_TOKENS_CHAT;
      delete process.env.OPENAI_MAX_TOKENS_PLANNING;
    }
  });
});
