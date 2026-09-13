/**
 * The embedded release public key must be the SAME key the installer signs with. This test fails
 * until `scripts/installer/keys/minisign.pub` exists and the constant matches it, so a placeholder
 * cannot ship quietly.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMinisignPublicKey } from "../minisign.js";
import { TRENT_RELEASE_PUBLIC_KEY, TRENT_RELEASE_PUBLIC_KEY_IS_PLACEHOLDER } from "../publicKey.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.resolve(here, "../../../../../scripts/installer/keys/minisign.pub");

describe("embedded release public key", () => {
  it("is the real installer key, not a placeholder", () => {
    expect(fs.existsSync(KEY_FILE), `missing ${KEY_FILE}`).toBe(true);
    expect(TRENT_RELEASE_PUBLIC_KEY_IS_PLACEHOLDER).toBe(false);
    const onDisk = parseMinisignPublicKey(fs.readFileSync(KEY_FILE, "utf8"));
    const embedded = parseMinisignPublicKey(TRENT_RELEASE_PUBLIC_KEY);
    expect(embedded.keyId).toBe(onDisk.keyId);
    expect(embedded.publicKey.equals(onDisk.publicKey)).toBe(true);
  });
});
