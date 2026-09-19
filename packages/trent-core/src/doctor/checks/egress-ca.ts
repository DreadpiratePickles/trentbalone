/**
 * The local egress root, as OpenSSL sees it.
 *
 * `CertificateAuthority` mints the root once and reuses it forever, so a host that minted before
 * 8b369d6 keeps a certificate whose DER serial carries a redundant leading zero octet. Node,
 * curl and every sandbox reject it with `asn1 encoding routines::illegal padding`, and the
 * failure surfaces as an unexplained TLS error on the first interception, never as a file name.
 *
 * So the check does the one thing the proxy never does: it parses the persisted file with
 * `node:crypto` and reports the parse error against the path. A root that parses is reported as
 * such; no root at all is not a fault, because the proxy mints one on first use.
 */
import fs from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import type { ConfigManager } from "../../config/ConfigManager.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

const CATEGORY = "Egress";
const NAME = "Egress Interception Root";
const CA_DIR = "egress";
const CA_FILE = "ca.crt";

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

/**
 * `<profile>/egress/ca.crt`. For the default profile this is the directory
 * `CertificateAuthority` itself defaults to (`TRENT_HOME` or `~/.trent`, plus `egress`).
 */
export function egressRootPath(configManager: ConfigManager): string {
  return path.join(configManager.getProfileDir(), CA_DIR, CA_FILE);
}

/** What the operator has to do, in full: the deletion, the re-mint, and the sandboxes. */
export function egressRootFixHint(caPath: string): string {
  return (
    `Delete ${caPath} (and the ${CA_FILE.replace(".crt", ".key")} beside it); the proxy mints a new root on the next ` +
    "interception. Any sandbox that trusted the old root must be rebuilt with `trent sandbox build`."
  );
}

/** The parse error, or null when the file reads as a certificate. */
export function egressRootParseError(caPath: string): string | null {
  try {
    const cert = new X509Certificate(fs.readFileSync(caPath));
    // Touching the subject forces the parse to have produced a usable certificate, not a stub.
    return cert.subject.length > 0 ? null : "the certificate carries no subject";
  } catch (err) {
    return (err as Error).message;
  }
}

export const checkEgressRoot: DoctorCheck = {
  id: "check_egress_ca",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const caPath = egressRootPath(ctx.configManager);

    if (!fs.existsSync(caPath)) {
      return result({
        status: "ok",
        message: `No egress root at ${caPath}; the proxy mints one the first time it intercepts TLS.`,
        details: { caPath, exists: false },
      });
    }

    const parseError = egressRootParseError(caPath);
    if (parseError !== null) {
      return result({
        status: "fail",
        message:
          `${caPath} is not a certificate OpenSSL will accept: ${parseError}. ` +
          "Every TLS interception through the egress proxy fails while this file is in place.",
        fixHint: egressRootFixHint(caPath),
        autoFixable: true,
        details: { caPath, exists: true, parseError },
      });
    }

    const cert = new X509Certificate(fs.readFileSync(caPath));
    return result({
      status: "ok",
      message: `The egress root at ${caPath} parses; it is valid until ${cert.validTo}.`,
      details: { caPath, exists: true, subject: cert.subject, validTo: cert.validTo },
    });
  },
};
