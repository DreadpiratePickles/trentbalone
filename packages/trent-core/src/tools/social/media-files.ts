/**
 * Files a post attaches: `media: [{path, alt}]` on `social_post` and `social_schedule`, uploaded on
 * the Bluesky path only (Buffer has no upload endpoint and the direct APIs take a hosted URL; see
 * `publish.ts` checkMediaRoute). Everything a human approves about a file is fixed here, before the
 * approval is asked: the path under the workspace (`tools/media/paths.ts` resolveInputPath, the
 * media toolset's own floor), the type from the bytes (`media-sniff.ts`), the size, the sha256, the
 * alt text and the upright aspect ratio. At send time {@link readMediaForSend} reads the same file
 * again and refuses when it is gone, moved or different from the digest that was approved.
 *
 * Bluesky's limits are the lexicons' (read 2026-09-25):
 *   app.bsky.embed.images  at most 4 images, `alt` required, each blob `image/*` of at most 2,000,000
 *                          bytes ("formerly limited to 1 MB")
 *     https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/images.json
 *   app.bsky.embed.video   one `video/mp4` blob of at most 300,000,000 bytes ("formerly limited to 100mb")
 *     https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/video.json
 * The images accepted here are JPEG, PNG, GIF and WebP, the types the posts guide shows; alt text
 * is required on a video too, though its lexicon leaves it optional.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { resolveInputPath } from "../media/paths.js";
import { imageSize, mp4Size, sniffMime, type Dimensions } from "./media-sniff.js";
import { SocialToolError } from "./types.js";

export const BLUESKY_MAX_IMAGES = 4;
export const BLUESKY_IMAGE_MAX_BYTES = 2_000_000;
export const BLUESKY_VIDEO_MAX_BYTES = 300_000_000;
const IMAGE_MIMES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VIDEO_MIME = "video/mp4";
const ACCEPTED = "Bluesky takes JPEG, PNG, GIF or WebP images and MP4 video";
const SNIFF_BYTES = 64;
const CHUNK = 1024 * 1024;

/** A file as the call names it: the path under the workspace and its alt text. */
export interface SocialMediaInput {
  readonly path: string;
  readonly alt: string;
}

/** A file as approved: what the preview named, and what the send re-checks. JSON, for the queue. */
export interface SocialMediaFile {
  /** As the call named it. */
  readonly path: string;
  /** The absolute real path it resolved to under the workspace when it was approved. */
  readonly file: string;
  readonly alt: string;
  readonly kind: "image" | "video";
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly aspectRatio?: Dimensions;
}

/** `media` as the call wrote it, or nothing when absent. Alt text is required on every file. */
export function parseMediaArg(raw: unknown): SocialMediaInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new SocialToolError("social_media_invalid", 'media must be a list of {"path": "<file under the workspace>", "alt": "<alt text>"}');
  if (raw.length === 0) return undefined;
  return raw.map((item, index) => {
    const entry = (item ?? {}) as { path?: unknown; alt?: unknown };
    const at = `media[${index}]`;
    if (typeof entry.path !== "string" || entry.path.trim() === "") throw new SocialToolError("social_media_invalid", `${at} needs a path: a file under the workspace`);
    if (typeof entry.alt !== "string" || entry.alt.trim() === "") {
      throw new SocialToolError("social_media_alt_required", `${at} (${entry.path}) has no alt text; every image or video needs one sentence saying what it shows, for people who cannot see it`);
    }
    return { path: entry.path.trim(), alt: entry.alt.trim() };
  });
}

function bytesText(n: number): string {
  return n.toLocaleString("en-US");
}

function readHead(file: string, length: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function sha256Of(file: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(CHUNK);
    for (let read = fs.readSync(fd, buffer, 0, CHUNK, null); read > 0; read = fs.readSync(fd, buffer, 0, CHUNK, null)) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function aspectOf(file: string, mime: string, bytes: number): Dimensions | undefined {
  if (mime === VIDEO_MIME) {
    const fd = fs.openSync(file, "r");
    try {
      return mp4Size((offset, length) => {
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, bytes - offset)));
        const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
        return buffer.subarray(0, read);
      }, bytes);
    } finally {
      fs.closeSync(fd);
    }
  }
  return imageSize(fs.readFileSync(file), mime);
}

/**
 * Each file resolved under `workspace` and checked against Bluesky's limits, cheapest check first,
 * so a refused call never hashes a large file: the path, the count, the type from the bytes, the
 * mix, the size, then the digest and the aspect ratio.
 */
export function resolveMediaFiles(workspace: string, inputs: readonly SocialMediaInput[]): SocialMediaFile[] {
  if (inputs.length > BLUESKY_MAX_IMAGES) throw new SocialToolError("bluesky_media_too_many", `${inputs.length} files: a Bluesky post carries at most four images, or one video`);
  const found = inputs.map((input) => {
    const resolved = resolveInputPath(workspace, input.path);
    if (!resolved.ok) {
      const code = resolved.status === "blocked" ? "social_media_outside_workspace" : "social_media_missing";
      throw new SocialToolError(code, `${input.path}: ${resolved.reason}`);
    }
    const bytes = fs.statSync(resolved.path.host).size;
    const mime = sniffMime(readHead(resolved.path.host, SNIFF_BYTES));
    const kind = mime === VIDEO_MIME ? "video" : mime !== undefined && IMAGE_MIMES.has(mime) ? "image" : undefined;
    if (kind === undefined) throw new SocialToolError("social_media_type_unsupported", `${input.path} is ${mime ?? "not a recognised image or video"} by its bytes; ${ACCEPTED}`);
    return { input, host: resolved.path.host, bytes, mime: mime!, kind } as const;
  });
  const videos = found.filter((f) => f.kind === "video").length;
  if (videos > 1 || (videos === 1 && found.length > 1)) throw new SocialToolError("bluesky_media_mixed", "a Bluesky post carries up to four images or one video, not both and not two videos");
  for (const f of found) {
    const limit = f.kind === "video" ? BLUESKY_VIDEO_MAX_BYTES : BLUESKY_IMAGE_MAX_BYTES;
    if (f.bytes > limit) {
      throw new SocialToolError(`bluesky_${f.kind}_too_large`, `${f.input.path} is ${bytesText(f.bytes)} bytes; Bluesky takes at most ${bytesText(limit)} bytes per ${f.kind} (app.bsky.embed.${f.kind === "video" ? "video" : "images"})`);
    }
  }
  return found.map((f) => {
    const aspectRatio = aspectOf(f.host, f.mime, f.bytes);
    return { path: f.input.path, file: f.host, alt: f.input.alt, kind: f.kind, mime: f.mime, bytes: f.bytes, sha256: sha256Of(f.host), ...(aspectRatio === undefined ? {} : { aspectRatio }) };
  });
}

/** One file as the card names it: its path, size, type, digest prefix and alt text. */
export function describeMediaFile(f: SocialMediaFile): string {
  return `${f.path} (${bytesText(f.bytes)} bytes, ${f.mime}, sha256 ${f.sha256.slice(0, 12)}) alt ${JSON.stringify(f.alt)}`;
}

/** What the human approves about the files: how many, then each one. */
export function renderMediaPreview(files: readonly SocialMediaFile[]): string {
  const noun = files[0]?.kind === "video" ? "video" : files.length === 1 ? "image" : "images";
  return `${files.length} ${noun}: ${files.map(describeMediaFile).join("; ")}`;
}

/**
 * The approved file's bytes, read now: refused when it is gone, when its path now resolves
 * elsewhere (a swapped symlink), or when its bytes are not the ones approved.
 */
export function readMediaForSend(file: SocialMediaFile): Buffer {
  let real: string;
  try {
    real = fs.realpathSync(file.file);
  } catch {
    throw new SocialToolError("social_media_missing", `${file.path} is gone since it was approved (${file.file}); nothing was sent`);
  }
  if (real !== file.file) throw new SocialToolError("social_media_changed", `${file.path} now resolves to ${real}, not the file that was approved; nothing was sent`);
  const bytes = fs.readFileSync(real);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== file.sha256) {
    throw new SocialToolError("social_media_changed", `${file.path} changed after it was approved (sha256 ${file.sha256.slice(0, 12)} approved, ${digest.slice(0, 12)} now); nothing was sent. Approve the new file: save it under a new name, since the same arguments are the same approval`);
  }
  return bytes;
}
