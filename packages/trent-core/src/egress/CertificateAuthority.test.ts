import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { CertificateAuthority } from "./CertificateAuthority.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "trent-ca-test-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("CertificateAuthority", () => {
  it("generates a CA certificate that is marked as a CA and persists it", () => {
    const dir = tmpDir();
    const ca = new CertificateAuthority({ dir });
    const pem = ca.getCertPem();

    expect(pem).toContain("BEGIN CERTIFICATE");
    const parsed = new crypto.X509Certificate(pem);
    expect(parsed.ca).toBe(true);
    expect(parsed.subject).toContain("Trent");
    expect(fs.existsSync(ca.getCaCertPath())).toBe(true);
    expect(fs.statSync(ca.getCaKeyPath()).mode & 0o777).toBe(0o600);
  });

  it("reuses the same CA across instances rather than minting a new one", () => {
    const dir = tmpDir();
    const first = new CertificateAuthority({ dir }).getCertPem();
    const second = new CertificateAuthority({ dir }).getCertPem();
    expect(second).toBe(first);
  });

  it("mints a leaf certificate for a host that verifies against the CA", () => {
    const ca = new CertificateAuthority({ dir: tmpDir() });
    const leaf = ca.issueLeaf("api.openai.com");

    const cert = new crypto.X509Certificate(leaf.certPem);
    const root = new crypto.X509Certificate(ca.getCertPem());
    expect(cert.ca).toBe(false);
    expect(cert.checkHost("api.openai.com")).toBe("api.openai.com");
    expect(cert.verify(root.publicKey)).toBe(true);
    expect(cert.checkPrivateKey(crypto.createPrivateKey(leaf.keyPem))).toBe(true);
  });

  it("caches leaves per host", () => {
    const ca = new CertificateAuthority({ dir: tmpDir() });
    expect(ca.issueLeaf("api.openai.com").certPem).toBe(ca.issueLeaf("api.openai.com").certPem);
    expect(ca.issueLeaf("api.openai.com").certPem).not.toBe(
      ca.issueLeaf("api.anthropic.com").certPem
    );
  });

  it("mints an IP-SAN leaf when the host is a literal address", () => {
    const ca = new CertificateAuthority({ dir: tmpDir() });
    const cert = new crypto.X509Certificate(ca.issueLeaf("127.0.0.1").certPem);
    expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
  });
});
