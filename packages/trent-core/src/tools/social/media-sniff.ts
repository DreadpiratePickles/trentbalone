/**
 * What a media file is, read from its bytes, never its name: the MIME type from the magic bytes,
 * and the upright display size a Bluesky embed's optional `aspectRatio` carries
 * (`app.bsky.embed.defs#aspectRatio`). The posts guide (https://docs.bsky.app/docs/advanced-guides/posts)
 * says to leave `aspectRatio` undefined rather than guess, so every reader here answers nothing
 * when the header is not what it expects.
 *
 *   JPEG  FF D8 FF; size from the first SOFn segment, turned by EXIF orientation 5 to 8
 *   PNG   89 50 4E 47 0D 0A 1A 0A; size from IHDR
 *   GIF   "GIF87a" / "GIF89a"; size from the logical screen descriptor
 *   WebP  "RIFF" .... "WEBP"; size from VP8X, VP8L or VP8
 *   MP4   an ISO BMFF `ftyp` whose major brand is an MP4 brand; size from the first `tkhd` with a
 *         non-zero width, turned when its matrix is a 90 or 270 degree rotation. A `ftyp` with a
 *         QuickTime, 3GPP, HEIF/AVIF or audio brand is named as that type so a refusal can say so.
 */

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

const MP4_BRANDS = /^(isom|iso[2-9]|mp4[12]|avc1|M4V[ HP]|dash|mmp4|MSNV|f4v )$/;

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
}

/** The MIME type the first bytes say, or nothing for a file that is none of the types named above. */
export function sniffMime(head: Uint8Array): string | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return "image/png";
  if (/^GIF8[79]a$/.test(ascii(head, 0, 6))) return "image/gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "image/webp";
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    if (/^3g[p2]/.test(brand)) return "video/3gpp";
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "image/heic";
    if (/^(avif|avis)$/.test(brand)) return "image/avif";
    if (/^M4[ABP] $/.test(brand)) return "audio/mp4";
    if (MP4_BRANDS.test(brand)) return "video/mp4";
  }
  return undefined;
}

function be16(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}

function be32(b: Uint8Array, at: number): number {
  return (((b[at] ?? 0) << 24) >>> 0) + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));
}

function le16(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}

function le24(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
}

function sized(width: number, height: number): Dimensions | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** EXIF orientation from an APP1 payload that starts at `at` with "Exif\0\0"; 1 when absent. */
function exifOrientation(b: Uint8Array, at: number, end: number): number {
  const tiff = at + 6;
  const little = ascii(b, tiff, tiff + 2) === "II";
  const u16 = (o: number) => (little ? le16(b, o) : be16(b, o));
  const u32 = (o: number) => (little ? (le16(b, o) | (le16(b, o + 2) << 16)) >>> 0 : be32(b, o));
  const ifd = tiff + u32(tiff + 4);
  const count = ifd + 2 <= end ? u16(ifd) : 0;
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 1;
}

function jpegSize(b: Uint8Array): Dimensions | undefined {
  let orientation = 1;
  let at = 2;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = be16(b, at + 2);
    if (marker === 0xe1 && ascii(b, at + 4, at + 10) === "Exif\0\0") orientation = exifOrientation(b, at + 4, at + 2 + length);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = be16(b, at + 5);
      const width = be16(b, at + 7);
      return orientation >= 5 && orientation <= 8 ? sized(height, width) : sized(width, height);
    }
    at += 2 + length;
  }
  return undefined;
}

function webpSize(b: Uint8Array): Dimensions | undefined {
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8X") return sized(le24(b, 24) + 1, le24(b, 27) + 1);
  if (chunk === "VP8L" && b[20] === 0x2f) {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return sized(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  return undefined;
}

/** The upright size of an image from its first bytes (JPEG: up to the first frame header). */
export function imageSize(head: Uint8Array, mime: string): Dimensions | undefined {
  if (mime === "image/png" && ascii(head, 12, 16) === "IHDR") return sized(be32(head, 16), be32(head, 20));
  if (mime === "image/gif") return sized(le16(head, 6), le16(head, 8));
  if (mime === "image/webp") return webpSize(head);
  if (mime === "image/jpeg") return jpegSize(head);
  return undefined;
}

/** Reads `length` bytes at `offset` of the file; fewer at its end. */
export type ReadAt = (offset: number, length: number) => Uint8Array;

/** The children of a box payload `[start, end)` of `b`: type and payload bounds. */
function* boxes(b: Uint8Array, start: number, end: number): Generator<{ type: string; start: number; end: number }> {
  let at = start;
  while (at + 8 <= end) {
    const size = be32(b, at);
    if (size < 8 || at + size > end) return;
    yield { type: ascii(b, at + 4, at + 8), start: at + 8, end: at + size };
    at += size;
  }
}

function tkhdSize(b: Uint8Array, start: number): Dimensions | undefined {
  const version = b[start];
  const matrix = start + 4 + (version === 1 ? 32 : 20) + 16;
  const width = Math.round(be32(b, matrix + 36) / 0x10000);
  const height = Math.round(be32(b, matrix + 40) / 0x10000);
  // [a b u; c d v; x y w]: a = d = 0 is a quarter turn, so the display size is the stored one turned.
  const turned = be32(b, matrix) === 0 && be32(b, matrix + 16) === 0;
  return turned ? sized(height, width) : sized(width, height);
}

/** The display size of an MP4's first video track: walks the top-level boxes to `moov` wherever it sits. */
export function mp4Size(readAt: ReadAt, fileBytes: number, maxMoovBytes = 64 * 1024 * 1024): Dimensions | undefined {
  let at = 0;
  while (at + 8 <= fileBytes) {
    const header = readAt(at, 16);
    let size = be32(header, 0);
    const type = ascii(header, 4, 8);
    let headerBytes = 8;
    if (size === 1) {
      size = be32(header, 8) * 2 ** 32 + be32(header, 12);
      headerBytes = 16;
    } else if (size === 0) size = fileBytes - at;
    if (size < headerBytes) return undefined;
    if (type === "moov") {
      if (size > maxMoovBytes) return undefined;
      const moov = readAt(at + headerBytes, size - headerBytes);
      for (const trak of boxes(moov, 0, moov.length)) {
        if (trak.type !== "trak") continue;
        for (const child of boxes(moov, trak.start, trak.end)) {
          if (child.type !== "tkhd") continue;
          const found = tkhdSize(moov, child.start);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    }
    at += size;
  }
  return undefined;
}
