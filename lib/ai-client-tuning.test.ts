import { describe, expect, it } from "vitest";
import { modelChatTuning } from "@/lib/ai-client";

describe("modelChatTuning", () => {
  it("uses max_completion_tokens and drops temperature for gpt-5 / o-series models", () => {
    expect(modelChatTuning("gpt-5.2", 100, 0.2)).toEqual({ max_completion_tokens: 100 });
    expect(modelChatTuning("gpt-5.2-codex", 100, 0.5)).toEqual({ max_completion_tokens: 100 });
    expect(modelChatTuning("o1-mini", 100, 0.2)).toEqual({ max_completion_tokens: 100 });
    expect(modelChatTuning("o3", 100)).toEqual({ max_completion_tokens: 100 });
  });

  it("uses max_tokens + temperature for gpt-4 family models", () => {
    expect(modelChatTuning("gpt-4.1-mini", 100, 0.2)).toEqual({ max_tokens: 100, temperature: 0.2 });
    expect(modelChatTuning("gpt-4.1-nano", 100)).toEqual({ max_tokens: 100 });
  });
});
