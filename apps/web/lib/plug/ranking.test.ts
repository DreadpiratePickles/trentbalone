import { describe, expect, it } from "vitest";
import { listLaunchPlugs } from "@/lib/plug/registry";
import { rankPlugs } from "@/lib/plug/ranking";

describe("Plug marketplace ranking", () => {
  it("ranks only plugs with finite measured outcomes", () => {
    const plug = listLaunchPlugs()[0];
    const ranked = rankPlugs([
      plug,
      { ...plug, id: "plug_unmeasured_capability", capabilityScore: Number.NaN },
      { ...plug, id: "plug_unmeasured_completion", completionRate: Number.POSITIVE_INFINITY },
    ]);

    expect(ranked.map((item) => item.id)).toEqual([plug.id]);
  });
});
