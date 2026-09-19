/**
 * The persisted egress root. A host that minted its root before 8b369d6 keeps a certificate whose
 * DER serial carries a redundant leading zero octet; OpenSSL refuses it with
 * `asn1 encoding routines::illegal padding`, so every TLS interception fails with a message that
 * names neither the file nor the fix. The check parses the file and the fix deletes it.
 *
 * The bad root here is minted with node-forge on the exact pathological serial the old `serial()`
 * could draw: two leading zero octets, of which forge's DER encoder strips only one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import forge from "node-forge";
import { ConfigManager } from "../../config/ConfigManager.js";
import { FixRunner } from "../FixRunner.js";
import { checkEgressRoot, egressRootPath } from "./egress-ca.js";
import type { DoctorContext } from "../types.js";

let tempDir: string;
let configManager: ConfigManager;

/** A serial OpenSSL refuses: forge strips one of the two leading zeros and leaves illegal padding. */
const NON_MINIMAL_SERIAL = "00007fa5a5a5a5a5a5a5a5a5a5a5a5a5";
/** The same 16 octets with a positive leading byte: nothing to strip, nothing to refuse. */
const MINIMAL_SERIAL = "417fa5a5a5a5a5a5a5a5a5a5a5a5a5a5";

const context = (over: Partial<DoctorContext> = {}): DoctorContext => ({
  baseDir: tempDir,
  profile: "default",
  configManager,
  probeTimeoutMs: 200,
  ...over,
});

/** A self-signed root on a chosen serial, written where the proxy keeps its own. */
function writeRoot(serialHex: string): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serialHex;
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: "commonName", value: "Trent Local Egress CA" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "basicConstraints", cA: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const file = egressRootPath(configManager);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, forge.pki.certificateToPem(cert));
  return file;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-egress-ca-"));
  configManager = new ConfigManager({ baseDir: tempDir });
  configManager.ensureDirs();
  vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("egress interception root check", () => {
  it("the pathological serial is genuinely unreadable, so the check has something real to find", () => {
    const file = writeRoot(NON_MINIMAL_SERIAL);
    expect(() => new crypto.X509Certificate(fs.readFileSync(file))).toThrow(/illegal padding/);
  });

  it("fails on a root OpenSSL cannot parse, naming the file and the whole fix", async () => {
    const file = writeRoot(NON_MINIMAL_SERIAL);
    const result = await checkEgressRoot.run(context());
    expect(result.status).toBe("fail");
    expect(result.message).toContain(file);
    expect(result.message).toContain("illegal padding");
    expect(result.fixHint).toContain(file);
    expect(result.fixHint).toContain("sandbox build");
    expect(result.autoFixable).toBe(true);
    expect(result.details?.caPath).toBe(file);
    // The check reports; it never removes anything on its own.
    expect(fs.existsSync(file)).toBe(true);
  });

  it("passes on a root that parses", async () => {
    writeRoot(MINIMAL_SERIAL);
    const result = await checkEgressRoot.run(context());
    expect(result.status).toBe("ok");
    expect(result.details?.subject).toContain("Trent Local Egress CA");
  });

  it("passes when no root has been minted yet", async () => {
    const result = await checkEgressRoot.run(context());
    expect(result.status).toBe("ok");
    expect(result.message).toContain(egressRootPath(configManager));
    expect(fs.existsSync(egressRootPath(configManager))).toBe(false);
  });

  it("--fix deletes the unreadable root, but only after saying so, and leaves a good one alone", async () => {
    const file = writeRoot(NON_MINIMAL_SERIAL);
    const announced: string[] = [];
    const fixer = new FixRunner(configManager, {
      probeTimeoutMs: 150,
      checks: [checkEgressRoot],
      // The announcement has to precede the unlink, or `--fix` deletes a file the operator
      // never heard about.
      announce: (line) => {
        announced.push(line);
        expect(fs.existsSync(file)).toBe(true);
      },
    });

    const { actions, newReport } = await fixer.runFixes();
    expect(fs.existsSync(file)).toBe(false);
    expect(announced.join("\n")).toContain(file);
    expect(announced.join("\n")).toContain("sandbox build");
    const action = actions.find((a) => a.action === "remove_unreadable_egress_root");
    expect(action).toMatchObject({ changed: true, success: true });
    expect(action?.message).toContain(file);
    expect(newReport.results[0]?.status).toBe("ok");
  });

  it("--fix leaves a readable root in place and announces nothing", async () => {
    const file = writeRoot(MINIMAL_SERIAL);
    const announced: string[] = [];
    const fixer = new FixRunner(configManager, {
      probeTimeoutMs: 150,
      checks: [checkEgressRoot],
      announce: (line) => announced.push(line),
    });
    const { actions } = await fixer.runFixes();
    expect(fs.existsSync(file)).toBe(true);
    expect(announced).toEqual([]);
    expect(actions.find((a) => a.action === "remove_unreadable_egress_root")).toMatchObject({ changed: false });
  });
});
