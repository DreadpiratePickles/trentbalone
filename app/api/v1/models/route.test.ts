import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("/v1/models", () => {
  it("returns an OpenAI-compatible model list with Trent tier metadata", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data.map((model: { id: string }) => model.id)).toContain("trent-sonnet");
    expect(body.trent.capabilities).toContain("chat.completions");
  });
});
