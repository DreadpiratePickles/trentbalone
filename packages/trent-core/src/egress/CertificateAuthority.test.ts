import { describe, it, expect, afterEach, vi } from "vitest";
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

/**
 * Pull the raw content octets of the certificate's serialNumber INTEGER out of the DER.
 *
 *   Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] version, serialNumber INTEGER, ... } }
 *
 * Only the header walk is needed, so this stays a few lines rather than a dependency.
 */
function serialOctets(certPem: string): Buffer {
  const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ""), "base64");
  let i = 0;
  /** Content length of the element at `i`, and the offset of its first content octet. */
  const header = (): { length: number; content: number } => {
    const first = der[i + 1]!;
    if ((first & 0x80) === 0) return { length: first, content: i + 2 };
    const n = first & 0x7f;
    let length = 0;
    for (let k = 0; k < n; k++) length = (length << 8) | der[i + 2 + k]!;
    return { length, content: i + 2 + n };
  };
  const enter = (): void => {
    i = header().content;
  };
  const skip = (): void => {
    const { length, content } = header();
    i = content + length;
  };
  enter(); // into Certificate SEQUENCE
  enter(); // into TBSCertificate SEQUENCE
  if (der[i] === 0xa0) skip(); // over the whole [0] EXPLICIT version element
  expect(der[i]).toBe(0x02); // serialNumber INTEGER
  const { length, content } = header();
  return der.subarray(content, content + length);
}

/** DER requires the shortest possible INTEGER encoding, and RFC 5280 requires a positive serial. */
function expectMinimalPositiveInteger(octets: Buffer): void {
  expect(octets.length).toBeGreaterThan(0);
  expect(octets[0]! & 0x80).toBe(0); // positive
  if (octets.length > 1 && octets[0] === 0x00) {
    // a leading 0x00 is only legal when it is carrying the next byte's high bit
    expect(octets[1]! & 0x80).toBe(0x80);
  }
}

/**
 * Forces the exact 16 random bytes `serial()` consumes.
 *
 * `00` followed by a byte whose high bit is clear is the pathological pattern: node-forge's
 * `asn1.toDer` strips exactly ONE leading zero, so the wire value keeps a second, illegal one.
 */
function forceSerialBytes(first: number, second: number): () => void {
  const real = crypto.randomBytes.bind(crypto);
  const filler = Buffer.alloc(14, 0xa5);
  const spy = vi.spyOn(crypto, "randomBytes").mockImplementation(((size: number) =>
    size === 16 ? Buffer.concat([Buffer.from([first, second]), filler]) : real(size)) as never);
  return () => spy.mockRestore();
}

describe("CertificateAuthority serial numbers", () => {
  it("encodes a minimal DER serial when the random bytes start 0x00 0x7f", () => {
    const restore = forceSerialBytes(0x00, 0x7f);
    try {
      const ca = new CertificateAuthority({ dir: tmpDir() });
      const leafPem = ca.issueLeaf("127.0.0.1").certPem;

      expectMinimalPositiveInteger(serialOctets(ca.getCertPem()));
      expectMinimalPositiveInteger(serialOctets(leafPem));
      const cert = new crypto.X509Certificate(leafPem);
      expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
    } finally {
      restore();
    }
  });

  it("encodes a minimal DER serial for every leading-byte value", () => {
    for (const first of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
      for (const second of [0x00, 0x7f, 0x80, 0xff]) {
        const restore = forceSerialBytes(first, second);
        try {
          const ca = new CertificateAuthority({ dir: tmpDir() });
          const leafPem = ca.issueLeaf("10.0.0.1").certPem;
          expectMinimalPositiveInteger(serialOctets(leafPem));
          expect(new crypto.X509Certificate(leafPem).checkIP("10.0.0.1")).toBe("10.0.0.1");
        } finally {
          restore();
        }
      }
    }
  });
});
