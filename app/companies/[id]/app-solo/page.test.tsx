import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

const redirect = vi.fn((url: string) => {
  throw new Error(`redirect:${url}`);
});

vi.mock("next/navigation", () => ({ redirect }));

describe("App Solo legacy route", () => {
  it("redirects into Workbench Agents mode", async () => {
    const { default: Page } = await import("./page");

    await expect(Page({ params: Promise.resolve({ id: "co_123" }) })).rejects.toThrow(
      "redirect:/companies/co_123/workbench?mode=agents",
    );
    expect(redirect).toHaveBeenCalledWith("/companies/co_123/workbench?mode=agents");
  });
});
