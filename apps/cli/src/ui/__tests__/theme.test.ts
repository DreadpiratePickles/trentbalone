import { describe, it, expect } from "vitest";
import { createTheme, AGENT_CATEGORIES, PULSE_SGR, EMBER_SGR, sgrCodesIn } from "../theme.js";
import type { ColorMode } from "../capabilities.js";
import { STATES, glyphFor } from "../glyphs.js";

const MODES: ColorMode[] = ["none", "ansi16", "ansi256", "truecolor"];
const ESC = /\x1b\[/;

describe("colour modes", () => {
  it("emits zero escape sequences in none mode, for every role", () => {
    const t = createTheme("none");
    const out = [
      t.meta("2.3 S"),
      t.success("done"),
      t.needsApproval("approve?"),
      t.error("failed"),
      t.dim("hint"),
      t.emphasis("Trent"),
      t.value("$0.12"),
      t.agentName("Engineer", "engineering"),
      t.stateChip("running"),
      t.stateChip("needsApproval"),
    ].join("\n");
    expect(out).not.toMatch(ESC);
  });

  it("emits escapes in every colour mode except none", () => {
    for (const mode of MODES) {
      const painted = createTheme(mode).success("ok");
      if (mode === "none") expect(painted).not.toMatch(ESC);
      else expect(painted).toMatch(ESC);
    }
  });

  it("distinguishes all five states by glyph alone in none mode", () => {
    const t = createTheme("none");
    const chips = STATES.map((s) => t.stateChip(s));
    expect(new Set(chips).size).toBe(STATES.length);
    for (const s of STATES) expect(t.stateChip(s)).toContain(glyphFor(s));
    expect(new Set(STATES.map(glyphFor)).size).toBe(STATES.length);
  });

  it("keeps all five states mutually distinguishable in ansi16", () => {
    const t = createTheme("ansi16");
    const chips = STATES.map((s) => t.stateChip(s));
    expect(new Set(chips).size).toBe(STATES.length);
    // and in ansi16 every chip is a *16-colour* code, never a 256 or truecolor one
    for (const chip of chips) {
      expect(chip).not.toMatch(/38;5;/);
      expect(chip).not.toMatch(/38;2;/);
    }
  });

  it("uses 38;5; in ansi256 and 38;2; in truecolor", () => {
    expect(createTheme("ansi256").success("x")).toMatch(/38;5;121m/);
    expect(createTheme("truecolor").success("x")).toMatch(/38;2;110;231;183m/);
  });

  it("resets colour at the end of every painted span", () => {
    for (const mode of ["ansi16", "ansi256", "truecolor"] as ColorMode[]) {
      expect(createTheme(mode).emphasis("Trent").endsWith("\x1b[0m")).toBe(true);
    }
  });
});

describe("the sacred colour grammar", () => {
  it("never puts pulse and ember on the same element, in any mode", () => {
    for (const mode of MODES) {
      const t = createTheme(mode);
      const elements = [
        t.success("done"),
        t.needsApproval("waiting on you"),
        t.stateChip("running"),
        t.stateChip("needsApproval"),
        t.stateChip("done"),
        t.stateChip("failed"),
        t.stateChip("idle"),
        ...AGENT_CATEGORIES.flatMap((c) => STATES.map((s) => t.agentLabel("Ada", c, s))),
      ];
      for (const el of elements) {
        const codes = sgrCodesIn(el);
        const hasPulse = codes.includes(PULSE_SGR[mode]);
        const hasEmber = codes.includes(EMBER_SGR[mode]);
        expect(hasPulse && hasEmber, `mode=${mode} element=${JSON.stringify(el)}`).toBe(false);
      }
    }
  });

  it("state outranks identity: an agent awaiting a human renders ember whatever its category", () => {
    const t = createTheme("truecolor");
    for (const c of AGENT_CATEGORIES) {
      const label = t.agentLabel("Ada", c, "needsApproval");
      expect(sgrCodesIn(label)).toContain(EMBER_SGR.truecolor);
    }
  });

  it("demotes a category whose colour collides with ember when the state signal is pulse", () => {
    const t = createTheme("truecolor");
    // marketing is #FB923C, the same hex as ember
    const label = t.agentLabel("Ada", "marketing", "running");
    expect(sgrCodesIn(label)).not.toContain(EMBER_SGR.truecolor);
  });

  it("exposes exactly the 13 agent categories from the style contract", () => {
    expect(AGENT_CATEGORIES).toHaveLength(13);
    expect(AGENT_CATEGORIES).toContain("spatial-computing");
    expect(AGENT_CATEGORIES).toContain("project-management");
  });

  it("uses mist for body text and bone only for emphasis and values", () => {
    const t = createTheme("truecolor");
    expect(t.body("hello")).toMatch(/38;2;148;163;184m/);
    expect(t.emphasis("hello")).toMatch(/38;2;241;236;226m/);
    expect(t.value("$1")).toMatch(/38;2;241;236;226m/);
  });

  it("renders diff-add as pulse and diff-del as ember, never green/red", () => {
    const t = createTheme("truecolor");
    expect(sgrCodesIn(t.diffAdd("+ line"))).toContain(PULSE_SGR.truecolor);
    expect(sgrCodesIn(t.diffDel("- line"))).toContain(EMBER_SGR.truecolor);
  });
});

describe("no emoji", () => {
  it("no rendered string contains an extended pictographic character", () => {
    for (const mode of MODES) {
      const t = createTheme(mode);
      const out = [
        ...STATES.map((s) => t.stateChip(s)),
        ...AGENT_CATEGORIES.map((c) => t.agentLabel("Ada", c, "running")),
        t.meta("2.3 S  $0.12  SONNET"),
      ].join("");
      expect(out).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
