/**
 * The local certificate authority behind TLS interception.
 *
 * Node's own `crypto` can parse and verify X.509 (`crypto.X509Certificate`) but it cannot *create*
 * a certificate: there is no signing/issuing API. So key material is generated with Node's native
 * `generateKeyPairSync` - fast, audited, no JS PRNG - and only the certificate structure and its
 * signature go through `node-forge`, which is the smallest well-known library that can emit a
 * signed X.509. That split keeps the pure-JS surface to ASN.1 encoding.
 *
 * The CA private key is written 0600 and never leaves the host. Only the public certificate is
 * mounted into a sandbox.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import forge from "node-forge";

export interface CertificateAuthorityOptions {
  /** Directory holding ca.crt / ca.key. Defaults to ~/.trent/egress. */
  dir?: string;
  /** Subject common name of the root. */
  commonName?: string;
  /** Root validity in days. */
  validityDays?: number;
}

export interface KeyPairPem {
  certPem: string;
  keyPem: string;
}

const CA_CERT_FILE = "ca.crt";
const CA_KEY_FILE = "ca.key";
const LEAF_KEY_FILE = "leaf.key";
const OWNER_ONLY = 0o600;

function defaultDir(): string {
  return path.join(os.homedir(), ".trent", "egress");
}

function writePrivate(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: OWNER_ONLY });
  fs.chmodSync(file, OWNER_ONLY);
}

function generateRsaPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/**
 * A positive serial that node-forge encodes as a MINIMAL DER INTEGER.
 *
 * `00` + random is not safe here. node-forge hands the hex straight to `asn1.toDer`, which
 * strips exactly ONE leading zero octet (and only when the next octet's high bit is clear).
 * So when the first random byte is itself 0x00 and the second has its high bit clear - about
 * 1 certificate in 512 - the wire value keeps a second, redundant 0x00. DER requires the
 * shortest form, and OpenSSL rejects the long one with ASN1_R_ILLEGAL_PADDING. Nothing about
 * the runner caused this: measured at 10/5000 on macOS/OpenSSL 3.5.8 and 8/5000 on
 * OpenSSL 3.0.15. CI just drew the losing serial first.
 *
 * Forcing the leading octet into 0x01..0x7f makes the integer positive with no pad octet at
 * all: nothing for forge to strip, nothing for OpenSSL to reject. 127 bits of entropy over
 * 16 octets, well inside RFC 5280's 20-octet ceiling.
 */
function serial(): string {
  const bytes = crypto.randomBytes(16);
  bytes[0] = bytes[0]! & 0x7f;
  if (bytes[0] === 0) bytes[0] = 0x01;
  return bytes.toString("hex");
}

type ForgeAttr = { name?: string; shortName?: string; value: string };

function subjectAttrs(commonName: string): ForgeAttr[] {
  return [
    { name: "commonName", value: commonName },
    { name: "organizationName", value: "Trent Fleet" },
    { shortName: "OU", value: "Trent Egress Interception" },
  ];
}

export class CertificateAuthority {
  private readonly dir: string;
  private readonly commonName: string;
  private readonly validityDays: number;
  private readonly leafCache = new Map<string, KeyPairPem>();

  private caCertPem!: string;
  private caKeyPem!: string;
  private leafKeyPem!: string;

  constructor(options?: CertificateAuthorityOptions) {
    this.dir = options?.dir ?? defaultDir();
    this.commonName = options?.commonName ?? "Trent Local Egress CA";
    this.validityDays = options?.validityDays ?? 825;
    this.load();
  }

  public getCaCertPath(): string {
    return path.join(this.dir, CA_CERT_FILE);
  }

  public getCaKeyPath(): string {
    return path.join(this.dir, CA_KEY_FILE);
  }

  public getCertPem(): string {
    return this.caCertPem;
  }

  /** Mint (or return the cached) server certificate for one host. */
  public issueLeaf(host: string): KeyPairPem {
    const cached = this.leafCache.get(host);
    if (cached) return cached;

    const leafPrivate = forge.pki.privateKeyFromPem(this.leafKeyPem);
    const caPrivate = forge.pki.privateKeyFromPem(this.caKeyPem);
    const caCert = forge.pki.certificateFromPem(this.caCertPem);

    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.setRsaPublicKey(leafPrivate.n, leafPrivate.e);
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 60 * 60 * 1000);
    cert.setSubject(subjectAttrs(host));
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", critical: true, digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          net.isIP(host) ? { type: 7, ip: host } : { type: 2, value: host },
        ],
      },
    ]);
    cert.sign(caPrivate, forge.md.sha256.create());

    const issued: KeyPairPem = {
      certPem: forge.pki.certificateToPem(cert),
      keyPem: this.leafKeyPem,
    };
    this.leafCache.set(host, issued);
    return issued;
  }

  private load(): void {
    const certPath = this.getCaCertPath();
    const keyPath = this.getCaKeyPath();
    const leafKeyPath = path.join(this.dir, LEAF_KEY_FILE);

    if (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.existsSync(leafKeyPath)) {
      this.caCertPem = fs.readFileSync(certPath, "utf8");
      this.caKeyPem = fs.readFileSync(keyPath, "utf8");
      this.leafKeyPem = fs.readFileSync(leafKeyPath, "utf8");
      return;
    }

    this.caKeyPem = generateRsaPem();
    this.leafKeyPem = generateRsaPem();
    this.caCertPem = this.mintRoot(this.caKeyPem);

    fs.mkdirSync(this.dir, { recursive: true });
    writePrivate(keyPath, this.caKeyPem);
    writePrivate(leafKeyPath, this.leafKeyPem);
    fs.writeFileSync(certPath, this.caCertPem, { mode: 0o644 });
  }

  private mintRoot(keyPem: string): string {
    const privateKey = forge.pki.privateKeyFromPem(keyPem);
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(Date.now() + this.validityDays * 24 * 60 * 60 * 1000);
    const attrs = subjectAttrs(this.commonName);
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", critical: true, keyCertSign: true, cRLSign: true },
      { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(privateKey, forge.md.sha256.create());
    return forge.pki.certificateToPem(cert);
  }
}
