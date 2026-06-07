import { describe, expect, it } from "vitest";
import { workbenchPreviewFrameSrc } from "@/lib/workbench-preview-url";

describe("workbenchPreviewFrameSrc", () => {
  it("proxies loopback sandbox URLs through Trent so the user browser can reach Railway-local previews", () => {
    expect(workbenchPreviewFrameSrc({ id: "ws_1", previewUrl: "http://localhost:4100/" })).toBe("/api/workbench/ws_1/preview/");
    expect(workbenchPreviewFrameSrc({ id: "ws_2", previewUrl: "http://127.0.0.1:5173" })).toBe("/api/workbench/ws_2/preview/");
  });

  it("leaves public preview URLs unchanged", () => {
    expect(workbenchPreviewFrameSrc({ id: "ws_1", previewUrl: "https://preview.example.test" })).toBe("https://preview.example.test");
  });

  it("returns an empty string when no preview is ready", () => {
    expect(workbenchPreviewFrameSrc({ id: "ws_1" })).toBe("");
  });
});
