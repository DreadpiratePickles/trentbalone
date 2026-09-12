import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKEN_HEX, AGENT_CATEGORY_HEX } from "../theme.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(HERE, "..");
const REPO = resolve(HERE, "../../../../..");
const TOKENS_JSON = join(REPO, "01_discovery/output/design-tokens.json");
const STYLE_CONTRACT = join(REPO, "01_discovery/output/style-contract.md");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const tokensRaw = readFileSync(TOKENS_JSON, "utf8");
const contractRaw = readFileSync(STYLE_CONTRACT, "utf8");
const tokenColors: Record<string, string> = JSON.parse(tokensRaw).color;
const tokenHexes = new Set(Object.values(tokenColors).map((h) => h.replace("#", "").toUpperCase()));
const contractHexes = new Set((contractRaw.match(/\b[0-9A-Fa-f]{6}\b/g) ?? []).map((h) => h.toUpperCase()));

describe("colour provenance", () => {
  it("finds the authoritative token files", () => {
    expect(tokenHexes.size).toBeGreaterThanOrEqual(13);
    expect(tokenHexes.has("6EE7B7")).toBe(true);
    expect(tokenHexes.has("FB923C")).toBe(true);
  });

  it("uses no invented hex anywhere in apps/cli/src/ui", () => {
    const files = walk(UI_DIR).filter((f) => !f.includes("__tests__"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const raw of src.match(/#[0-9A-Fa-f]{6}\b/g) ?? []) {
        const hex = raw.slice(1).toUpperCase();
        // Authoritative: design-tokens.json first, then the style contract's own
        // documented extensions (sky + the 13 agent-category colours).
        if (!tokenHexes.has(hex) && !contractHexes.has(hex)) offenders.push(`${file}: ${raw}`);
      }
    }
    expect(offenders, `invented colours: ${offenders.join(", ")}`).toEqual([]);
  });

  it("takes the core palette verbatim from design-tokens.json", () => {
    for (const [name, jsonHex] of Object.entries(tokenColors)) {
      const key = name as keyof typeof TOKEN_HEX;
      if (!(key in TOKEN_HEX)) continue;
      expect(TOKEN_HEX[key].toUpperCase(), name).toBe(jsonHex.toUpperCase());
    }
    // the palette must at minimum re-use these roles unchanged
    expect(TOKEN_HEX.pulse.toUpperCase()).toBe(tokenColors.pulse!.toUpperCase());
    expect(TOKEN_HEX.ember.toUpperCase()).toBe(tokenColors.ember!.toUpperCase());
    expect(TOKEN_HEX.mist.toUpperCase()).toBe(tokenColors.mist!.toUpperCase());
    expect(TOKEN_HEX.bone.toUpperCase()).toBe(tokenColors.bone!.toUpperCase());
    expect(TOKEN_HEX.danger.toUpperCase()).toBe(tokenColors.danger!.toUpperCase());
  });

  it("takes every agent-category colour from the style contract", () => {
    for (const [cat, hex] of Object.entries(AGENT_CATEGORY_HEX)) {
      expect(contractHexes.has(hex.replace("#", "").toUpperCase()), `${cat} ${hex}`).toBe(true);
    }
  });

  it("uses no v1-spec purple and no raw green/red", () => {
    const src = walk(UI_DIR).filter((f) => !f.includes("__tests__")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(src).not.toMatch(/8B5CF6/i);
    expect(src).not.toMatch(/0F1117/i);
  });
});

describe("no emoji in the source itself", () => {
  it("holds for every file under apps/cli/src/ui", () => {
    for (const file of walk(UI_DIR)) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
