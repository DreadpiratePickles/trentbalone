/**
 * [H3] `{{payload.x}}` substitution from the JSON body: own properties only, clipped values.
 */
import { describe, expect, it } from "vitest";
import { MAX_VALUE_CHARS, renderWebhookTemplate } from "./template.js";

describe("renderWebhookTemplate", () => {
  const payload = { id: "evt_1", n: 42, ok: true, none: null, data: { object: { id: "in_9", lines: [{ sku: "A-1" }, { sku: "B-2" }] } } };

  it("fills dotted paths, array indexes, numbers, booleans and null", () => {
    expect(renderWebhookTemplate("{{payload.id}} {{ payload.data.object.id }} {{payload.data.object.lines.1.sku}} {{payload.n}} {{payload.ok}} {{payload.none}}", payload)).toBe("evt_1 in_9 B-2 42 true null");
  });

  it("renders an object as JSON and a missing path as nothing", () => {
    expect(renderWebhookTemplate("[{{payload.data.object.lines.0}}] [{{payload.missing.deep}}]", payload)).toBe('[{"sku":"A-1"}] []');
  });

  it("reads own properties only: an inherited name renders as nothing", () => {
    expect(renderWebhookTemplate("[{{payload.toString}}] [{{payload.id.length}}]", payload)).toBe("[] []");
  });

  it("clips a long value", () => {
    const rendered = renderWebhookTemplate("{{payload.long}}", { long: "x".repeat(MAX_VALUE_CHARS + 500) });
    expect(rendered.length).toBeLessThanOrEqual(MAX_VALUE_CHARS + 20);
    expect(rendered.endsWith("[clipped]")).toBe(true);
  });

  it("leaves a template with no references as it is", () => {
    expect(renderWebhookTemplate("Run the nightly report", payload)).toBe("Run the nightly report");
  });
});
