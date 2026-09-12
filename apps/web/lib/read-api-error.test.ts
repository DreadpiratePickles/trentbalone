import { describe, it, expect } from "vitest";
import { readApiError } from "@/lib/read-api-error";

describe("readApiError", () => {
  it("returns error field from JSON body", async () => {
    const res = new Response(JSON.stringify({ error: "company not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    await expect(readApiError(res)).resolves.toBe("company not found");
  });

  it("falls back to status when body is not JSON", async () => {
    const res = new Response("nope", { status: 500, statusText: "Internal Server Error" });
    await expect(readApiError(res)).resolves.toBe("Request failed (500 Internal Server Error)");
  });
});
