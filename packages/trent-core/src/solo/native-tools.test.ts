/**
 * [CF] C14.1: the tools a solo request offers natively on anthropic (`native-tools.ts`), read back from what each
 * adapter publishes, in solo's words. The runtime-level proof (the request carries them on anthropic and on no
 * other route) is `apps/cli/src/runtime/runner-for-mode.cf.test.ts`. Pure: adapters in, definitions out.
 */
import { describe, expect, it } from "vitest";
import { renderToolInstructions, type ToolSchema } from "../tools/web/schemas.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { createMemoryAdapter } from "../tools/memory/index.js";
import { fakeAdapter } from "./fakes.test-helpers.js";
import { offersNativeTools, soloNativeTools } from "./native-tools.js";

const ASK: ToolSchema = {
  name: "ask_human",
  description: "Ask the founder one question and wait for the answer.",
  parameters: { type: "object", properties: { question: { type: "string", description: "The question, self-contained: the founder sees nothing else." }, options: { type: "array" } }, required: ["question"] },
};
const human = (): TrentToolAdapter => ({ ...fakeAdapter({ name: "human", tools: ["ask_human"] }), instructions: renderToolInstructions([ASK]) });

describe("[CF] which route is offered native tools", () => {
  it("anthropic, however it is written; no other provider and no alias", () => {
    expect(offersNativeTools("anthropic")).toBe(true);
    expect(offersNativeTools(" Anthropic ")).toBe(true);
    for (const provider of ["openai", "google", "mistral", "openrouter", "ollama", "lmstudio", "deepseek", "groq", "", undefined]) expect(offersNativeTools(provider), String(provider)).toBe(false);
  });
});

describe("[CF] the native tool list", () => {
  it("each tool once, with its argument schema, and the memory tool's SOLO actions", () => {
    const tools = soloNativeTools([human(), createMemoryAdapter({ profileDir: "/nonexistent-cf" })]);
    expect(tools.map((tool) => tool.name)).toEqual(["ask_human", "memory"]);
    expect(tools[0]?.parameters).toMatchObject({ type: "object", required: ["question"], properties: { question: { type: "string" }, options: { type: "array" } } });
    expect(JSON.stringify(tools[1]?.parameters)).toContain('"enum":["add","replace","remove"]');
  });

  it('says "person" where the fleet\'s text says "founder", in the description and in each argument\'s', () => {
    const [ask] = soloNativeTools([human()]);
    expect(ask?.description).toBe("Ask the person one question and wait for the answer.");
    expect(JSON.stringify(ask?.parameters)).not.toMatch(/founder/i);
    expect((ask?.parameters.properties as Record<string, { description?: string }>).question?.description).toBe("The question, self-contained: the person sees nothing else.");
  });

  it("offers nothing for a tool whose adapter publishes no schema; the text protocol still teaches it", () => {
    const prose: TrentToolAdapter = { ...fakeAdapter({ name: "notes", tools: ["note_take"] }), instructions: "Take a note: note_take {\"text\": \"...\"}." };
    expect(soloNativeTools([prose])).toEqual([]);
  });
});
