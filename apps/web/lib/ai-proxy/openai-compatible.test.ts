import { describe, expect, it } from "vitest";
import {
  buildChatCompletion,
  normalizeChatRequest,
  StreamingNotSupportedError,
} from "@/lib/ai-proxy/openai-compatible";

describe("OpenAI-compatible chat completions", () => {
  it("normalizes chat requests and rejects streaming until SSE is implemented", () => {
    const normalized = normalizeChatRequest({
      model: "trent-sonnet",
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Summarize Trent." },
      ],
      temperature: 0.2,
      max_tokens: 128,
    });

    expect(normalized).toMatchObject({
      model: "trent-sonnet",
      prompt: "system: You are concise.\nuser: Summarize Trent.",
      maxTokens: 128,
    });
    expect(() => normalizeChatRequest({ model: "trent", messages: [], stream: true })).toThrow(StreamingNotSupportedError);
  });

  it("builds an OpenAI-compatible response through the model gateway", async () => {
    const result = await buildChatCompletion({
      companyId: "co_1",
      request: normalizeChatRequest({
        model: "trent-sonnet",
        messages: [{ role: "user", content: "Write a launch line." }],
      }),
    });

    expect(result.response).toMatchObject({
      object: "chat.completion",
      model: "trent-sonnet",
      choices: [{ index: 0, finish_reason: "stop" }],
      usage: {
        prompt_tokens: expect.any(Number),
        completion_tokens: expect.any(Number),
        total_tokens: expect.any(Number),
      },
    });
    expect(result.route.provider).toBe("anthropic");
    expect(result.amountCents).toBeGreaterThanOrEqual(0);
  });
});
