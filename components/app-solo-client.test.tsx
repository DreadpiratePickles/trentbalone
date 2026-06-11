import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppSoloClient } from "@/components/app-solo-client";

describe("AppSoloClient", () => {
  it("renders the selected agent contract in the live trace panel", () => {
    const html = renderToStaticMarkup(<AppSoloClient companyId="co_1" />);

    expect(html).toContain("agent contract");
    expect(html).toContain("Growth / Marketing");
    expect(html).toContain("Steel Browser");
    expect(html).toContain("mode");
    expect(html).toContain("design");
    expect(html).toContain("scopes");
    expect(html).toContain("steel:");
    expect(html).toContain("deliverables");
    expect(html).toContain("experiment backlog");
    expect(html).toContain("approval gates");
    expect(html).toContain("gmail.send");
  });
});
