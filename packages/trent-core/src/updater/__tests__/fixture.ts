/**
 * Test fixture: a throwaway Ed25519 keypair in minisign's key format, a signer that produces
 * minisign-format `.minisig` files, and a local HTTPS server that serves a fake GitHub release
 * layout. Nothing here is imported by production code; the signer exists only so the tests can
 * produce a signature the verifier must accept, and an invalid one it must refuse.
 *
 * Minisign formats (https://jedisct1.github.io/minisign/):
 *   public key : base64("Ed" || keyId[8] || pk[32])
 *   signature  : base64(alg[2] || keyId[8] || sig[64]); alg "ED" = Ed25519 over BLAKE2b-512(file)
 *   global sig : base64(Ed25519(sig[64] || trustedComment))
 */

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import forge from "node-forge";

export interface TestKeypair {
  publicKeyFile: string;
  privateKey: crypto.KeyObject;
  keyId: Buffer;
}

export function makeKeypair(): TestKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const raw = Buffer.from(jwk.x, "base64url");
  const keyId = crypto.randomBytes(8);
  const body = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  const publicKeyFile = `untrusted comment: minisign public key ${keyId.toString("hex").toUpperCase()}\n${body}\n`;
  return { publicKeyFile, privateKey, keyId };
}

export function minisignFile(content: Buffer, key: TestKeypair, trustedComment = "trent test"): string {
  const digest = crypto.createHash("blake2b512").update(content).digest();
  const sig = crypto.sign(null, digest, key.privateKey);
  const sigBlock = Buffer.concat([Buffer.from("ED"), key.keyId, sig]).toString("base64");
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trustedComment)]), key.privateKey);
  return [
    "untrusted comment: signature from trent test key",
    sigBlock,
    `trusted comment: ${trustedComment}`,
    global.toString("base64"),
    "",
  ].join("\n");
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export interface FakeRelease {
  version: string;
  assets: Record<string, Buffer>;
  prerelease?: boolean;
}

export interface ReleaseServer {
  baseUrl: string;
  host: string;
  caPem: string;
  /** Every request path the server saw, in order. */
  requests: string[];
  /** Mutable: tests swap bytes to simulate tampering, truncation or redirects. */
  files: Map<string, Buffer>;
  /** Paths that should be answered with a redirect to the given absolute URL. */
  redirects: Map<string, string>;
  /** Paths whose Content-Length overstates the body, so the connection closes early. */
  truncate: Set<string>;
  close: () => Promise<void>;
}

/** Build the `SHA256SUMS` text in the `sha256sum` format that `scripts/build-cli.sh` emits. */
export function sumsText(assets: Record<string, Buffer>): Buffer {
  return Buffer.from(
    Object.entries(assets)
      .map(([name, bytes]) => `${sha256Hex(bytes)}  ${name}`)
      .join("\n") + "\n",
  );
}

/**
 * Lay out one signed release the way the updater expects to find it under a base URL:
 *   <base>/api/releases/latest             GitHub-shaped JSON
 *   <base>/api/releases                    list, newest first
 *   <base>/releases/download/v<ver>/<name> the artefacts, SHA256SUMS and SHA256SUMS.minisig
 */
export function layoutRelease(
  server: ReleaseServer,
  release: FakeRelease,
  key: TestKeypair,
  options: { badSignature?: boolean } = {},
): void {
  const sums = sumsText(release.assets);
  const signer = options.badSignature === true ? makeKeypair() : key;
  const dir = `/releases/download/v${release.version}/`;
  for (const [name, bytes] of Object.entries(release.assets)) {
    server.files.set(dir + encodeURIComponent(name), bytes);
  }
  server.files.set(`${dir}SHA256SUMS`, sums);
  server.files.set(`${dir}SHA256SUMS.minisig`, Buffer.from(minisignFile(sums, signer)));
  const entry = {
    tag_name: `v${release.version}`,
    prerelease: release.prerelease === true,
    assets: Object.keys(release.assets).map((name) => ({ name })),
  };
  const existing = server.files.get("/api/releases");
  const list: unknown[] = existing ? (JSON.parse(existing.toString()) as unknown[]) : [];
  list.unshift(entry);
  server.files.set("/api/releases", Buffer.from(JSON.stringify(list)));
  if (release.prerelease !== true) {
    server.files.set("/api/releases/latest", Buffer.from(JSON.stringify(entry)));
  }
}

function selfSignedCert(): { key: string; cert: string } {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const priv = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(priv.n, priv.e);
  cert.serialNumber = "01" + crypto.randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: "commonName", value: "localhost" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] },
  ]);
  cert.sign(priv, forge.md.sha256.create());
  return { key: keyPem, cert: forge.pki.certificateToPem(cert) };
}

export async function startReleaseServer(): Promise<ReleaseServer> {
  const { key, cert } = selfSignedCert();
  const files = new Map<string, Buffer>();
  const redirects = new Map<string, string>();
  const truncate = new Set<string>();
  const requests: string[] = [];

  const server = https.createServer({ key, cert }, (req, res) => {
    const url = req.url ?? "/";
    requests.push(url);
    const redirect = redirects.get(url);
    if (redirect !== undefined) {
      res.writeHead(302, { Location: redirect });
      res.end();
      return;
    }
    const body = files.get(url);
    if (body === undefined) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (truncate.has(url)) {
      res.writeHead(200, { "Content-Length": String(body.length + 100) });
      // Flush the headers and the short body first, so the client sees a real truncation.
      res.write(body, () => setTimeout(() => res.socket?.destroy(), 20));
      return;
    }
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const host = `127.0.0.1:${port}`;
  return {
    baseUrl: `https://${host}`,
    host,
    caPem: cert,
    requests,
    files,
    redirects,
    truncate,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A fake "binary": a shell script whose `--version` prints the version it claims to be. */
export function fakeBinary(version: string): Buffer {
  return Buffer.from(`#!/bin/sh\necho "${version}"\n`);
}

export function tempHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeCa(home: string, caPem: string): string {
  const file = path.join(home, "test-ca.pem");
  fs.writeFileSync(file, caPem);
  return file;
}
