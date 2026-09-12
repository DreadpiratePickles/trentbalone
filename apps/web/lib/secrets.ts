import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function deriveKey(source: string): Buffer {
  if (/^[A-Za-z0-9+/=]{43,88}$/.test(source)) {
    try {
      const decoded = Buffer.from(source, "base64");
      if (decoded.length === 32) return decoded;
    } catch {
      // fall through to sha256 derivation
    }
  }
  return createHash("sha256").update(source).digest();
}

function getEncryptionKey(): Buffer {
  const configured = process.env.SECRET_ENCRYPTION_KEY;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("SECRET_ENCRYPTION_KEY is required in production");
  }
  return deriveKey(configured || "trent-local-development-secret");
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptJson<T>(encrypted: string): T {
  const [version, ivText, tagText, encryptedText] = encrypted.split(":");

  if (version === "v1") {
    if (!ivText || !tagText || !encryptedText) {
      throw new Error("Malformed v1 secret payload");
    }
    return decryptWithKey<T>(getEncryptionKey(), ivText, tagText, encryptedText);
  }

  throw new Error(`Unsupported secret version: ${version}`);
}

function decryptWithKey<T>(key: Buffer, ivText: string, tagText: string, encryptedText: string): T {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/**
 * Re-encrypt a single ciphertext string from oldKeySource to newKeySource.
 * Throws if the payload cannot be decrypted with the old key.
 */
export function rekeySecret(ciphertext: string, oldKeySource: string, newKeySource: string): string {
  const oldKey = deriveKey(oldKeySource);
  const [version, ivText, tagText, encryptedText] = ciphertext.split(":");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) {
    throw new Error(`Cannot rekey unsupported version: ${version}`);
  }

  const value = decryptWithKey<unknown>(oldKey, ivText, tagText, encryptedText);

  const newKey = deriveKey(newKeySource);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, newKey, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function maskSecret(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
