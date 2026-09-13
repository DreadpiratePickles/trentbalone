/**
 * Where `vision_analyze` may take an image from: a local file under the workspace or the profile
 * (the path floor; browser screenshots live under the profile), or an http(s) URL fetched through
 * the egress proxy behind the same SSRF floor as `web`. The bytes are typed by their magic
 * number, never by extension or Content-Type, so a text file renamed `.png` is refused.
 */
import fs from "node:fs";
import path from "node:path";
import { createEgressFetch, type EgressClientOptions, type FetchLike } from "../web/proxied-fetch.js";
import { checkUrlSafety, type LookupFn } from "../web/url-safety.js";

/** Hermes `vision_tools_image_prep.py` downsizes above this; Trent refuses instead. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface LoadedImage {
  readonly bytes: Buffer;
  readonly mimeType: ImageMime;
  readonly source: string;
}

export type ImageLoad = { ok: true; image: LoadedImage } | { ok: false; status: "blocked" | "failed"; reason: string };

export interface ImageSourceOptions {
  readonly workspace: string;
  readonly profileDir: string;
  readonly egress?: Omit<EgressClientOptions, "lookup">;
  /** Direct transport for tests only; bypasses the proxy. */
  readonly fetchImpl?: FetchLike;
  readonly lookup?: LookupFn;
}

/** The image type by magic number, or null when the bytes are not a supported image. */
export function sniffImage(bytes: Buffer): ImageMime | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/** Roots are realpath'd too: on macOS the temp dir is a symlink (`/var` -> `/private/var`). */
function within(file: string, root: string): boolean {
  let base = path.resolve(root);
  try {
    base = fs.realpathSync(base);
  } catch {
    // A missing root contains nothing.
    return false;
  }
  const relative = path.relative(base, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function typed(bytes: Buffer, source: string): ImageLoad {
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, status: "failed", reason: `${source} is ${bytes.length} bytes; the limit is ${MAX_IMAGE_BYTES}.` };
  const mimeType = sniffImage(bytes);
  if (!mimeType) return { ok: false, status: "failed", reason: `${source} is not a PNG, JPEG, GIF or WebP image.` };
  return { ok: true, image: { bytes, mimeType, source } };
}

/** A local path must resolve (symlinks included) under the workspace or the profile. */
export function loadLocalImage(raw: string, options: ImageSourceOptions): ImageLoad {
  const candidate = path.resolve(options.workspace, raw);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, status: "failed", reason: `${raw}: no such file.` };
  }
  if (!within(real, options.workspace) && !within(real, options.profileDir)) {
    return { ok: false, status: "blocked", reason: `${raw} is outside the workspace and the profile directory; vision_analyze reads only those.` };
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(real);
  } catch (err) {
    return { ok: false, status: "failed", reason: `${raw}: ${(err as Error).message}` };
  }
  return typed(bytes, raw);
}

export async function fetchRemoteImage(raw: string, options: ImageSourceOptions): Promise<ImageLoad> {
  const verdict = await checkUrlSafety(raw, { lookup: options.lookup });
  if (!verdict.ok) return { ok: false, status: "blocked", reason: `${raw}: ${verdict.reason}` };
  const transport: FetchLike | null = options.fetchImpl ?? (options.egress ? createEgressFetch({ ...options.egress, lookup: options.lookup }) : null);
  if (!transport) return { ok: false, status: "failed", reason: "vision_analyze has no transport for URLs: configure the egress proxy, or pass a local image_path." };
  try {
    const response = await transport(verdict.url.toString(), { method: "GET" });
    if (!response.ok) return { ok: false, status: "failed", reason: `${raw}: HTTP ${response.status}` };
    const bytes = Buffer.from(await response.arrayBuffer());
    return typed(bytes, raw);
  } catch (err) {
    return { ok: false, status: "failed", reason: `${raw}: ${(err as Error).message.split("\n")[0]}` };
  }
}

/** Data URIs, http(s) URLs and local paths, as Hermes's single `image_url` accepts. */
export async function loadImage(raw: string, options: ImageSourceOptions): Promise<ImageLoad> {
  const trimmed = raw.trim();
  if (/^data:image\/[a-z+.-]+;base64,/i.test(trimmed)) {
    const bytes = Buffer.from(trimmed.slice(trimmed.indexOf(",") + 1), "base64");
    return typed(bytes, "data URI");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    if (trimmed.startsWith("file://")) return { ok: false, status: "blocked", reason: "file:// URLs are refused; pass a plain path under the workspace instead." };
    return fetchRemoteImage(trimmed, options);
  }
  return loadLocalImage(trimmed, options);
}
