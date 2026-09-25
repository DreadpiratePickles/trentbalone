/**
 * [P1-D] the `connect` block of config.yaml: whether a profile other than `default` reads a
 * `trent connect` provider it never connected from the default profile's secrets file. On by
 * default (one grant per machine). It is `connect.*`, not `secrets.*`, because `trent config set
 * secrets.<name>` is the explicit route into the secrets file (`config/secrets-policy.ts`).
 */
import { describe, expect, it } from "vitest";
import { TrentConfigSchema } from "./schema.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { isSecretKey } from "./secrets-policy.js";

describe("[P1-D] connect config block", () => {
  it("the old secrets.inherit_default key no longer parses: it is not in the schema and sets nothing", () => {
    expect(Object.keys(TrentConfigSchema.shape)).not.toContain("secrets");
    expect(TrentConfigSchema.parse({})).not.toHaveProperty("secrets");
    expect(TrentConfigSchema.parse({ secrets: { inherit_default: false } }).connect).toEqual({ inherit_default: true });
  });

  it("defaults connect.inherit_default to true, in the schema and in the shipped defaults", () => {
    expect(TrentConfigSchema.parse({}).connect).toEqual({ inherit_default: true });
    expect(DEFAULT_CONFIG.connect).toEqual({ inherit_default: true });
  });

  it("accepts a boolean only and no other key, and config set routes it to config.yaml", () => {
    expect(TrentConfigSchema.parse({ connect: { inherit_default: false } }).connect).toEqual({ inherit_default: false });
    expect(TrentConfigSchema.safeParse({ connect: { inherit_default: "no" } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ connect: { GOOGLE_ACCESS_TOKEN: "never-here" } }).success).toBe(false);
    expect(isSecretKey("connect.inherit_default")).toBe(false);
  });
});
