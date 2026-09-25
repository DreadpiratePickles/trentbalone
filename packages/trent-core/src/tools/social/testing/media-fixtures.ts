/**
 * Byte-level media fixtures for the social media tests: the headers the sniffer reads (PNG IHDR,
 * JPEG SOF and EXIF orientation, GIF, WebP VP8X, an ISO BMFF `ftyp` with a `moov`/`trak`/`tkhd`
 * after the `mdat`), padded with zeros to any size. None of them decodes as a picture; they only
 * have to be what the first bytes say, which is all Bluesky's upload and this toolset look at.
 */

function be32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function be16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function le24(n: number): Buffer {
  return Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
}

function padTo(head: Buffer, size: number | undefined): Buffer {
  if (size === undefined || size <= head.length) return head;
  return Buffer.concat([head, Buffer.alloc(size - head.length)]);
}

export function png(width: number, height: number, size?: number): Buffer {
  const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0])]);
  const head = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), be32(13), Buffer.from("IHDR"), ihdr, be32(0)]);
  return padTo(head, size);
}

/** A JPEG with an optional EXIF APP1 segment carrying `orientation` (1 upright, 6 rotated 90 degrees). */
export function jpeg(width: number, height: number, options: { orientation?: number; size?: number } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (options.orientation !== undefined) {
    // TIFF, big-endian: header, IFD0 with one entry (0x0112 orientation, SHORT, count 1), next IFD 0.
    const tiff = Buffer.concat([Buffer.from("MM"), be16(42), be32(8), be16(1), be16(0x0112), be16(3), be32(1), be16(options.orientation), be16(0), be32(0)]);
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
    parts.push(Buffer.from([0xff, 0xe1]), be16(payload.length + 2), payload);
  }
  const jfif = Buffer.concat([Buffer.from("JFIF\0", "binary"), Buffer.from([1, 1, 0]), be16(1), be16(1), Buffer.from([0, 0])]);
  parts.push(Buffer.from([0xff, 0xe0]), be16(jfif.length + 2), jfif);
  const sof = Buffer.concat([Buffer.from([8]), be16(height), be16(width), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]);
  parts.push(Buffer.from([0xff, 0xc0]), be16(sof.length + 2), sof, Buffer.from([0xff, 0xd9]));
  return padTo(Buffer.concat(parts), options.size);
}

export function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write("GIF89a", 0, "binary");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

export function webp(width: number, height: number): Buffer {
  const vp8x = Buffer.concat([Buffer.from("VP8X"), Buffer.from([10, 0, 0, 0]), Buffer.from([0, 0, 0, 0]), le24(width - 1), le24(height - 1)]);
  const body = Buffer.concat([Buffer.from("WEBP"), vp8x]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), size, body]);
}

function box(type: string, payload: Buffer): Buffer {
  return Buffer.concat([be32(payload.length + 8), Buffer.from(type, "binary"), payload]);
}

/** A version-0 `tkhd` with the given display size; `rotate90` writes the 90-degree matrix phones use. */
function tkhd(width: number, height: number, rotate90: boolean): Buffer {
  const fixed = (n: number) => be32(n * 0x10000);
  const matrix = rotate90
    ? [be32(0), be32(0x10000), be32(0), be32(0xffff0000), be32(0), be32(0), be32(0), be32(0), be32(0x40000000)]
    : [be32(0x10000), be32(0), be32(0), be32(0), be32(0x10000), be32(0), be32(0), be32(0), be32(0x40000000)];
  return box("tkhd", Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.alloc(20), Buffer.alloc(16), ...matrix, fixed(width), fixed(height)]));
}

/**
 * An ISO BMFF file: `ftyp` with `brand`, then `mdat` (padded so the whole file is `size` bytes when
 * given), then `moov` holding an audio track (0 x 0) before the video track, the layout a
 * non-faststart export has.
 */
export function mp4(width: number, height: number, options: { brand?: string; rotate90?: boolean; size?: number } = {}): Buffer {
  const brand = options.brand ?? "isom";
  const ftyp = box("ftyp", Buffer.concat([Buffer.from(brand, "binary"), be32(512), Buffer.from("isomiso2mp41", "binary")]));
  const moov = box("moov", Buffer.concat([box("mvhd", Buffer.alloc(100)), box("trak", tkhd(0, 0, false)), box("trak", Buffer.concat([tkhd(width, height, options.rotate90 === true), box("mdia", Buffer.alloc(8))]))]));
  const fixed = ftyp.length + moov.length + 8;
  const mdatPayload = Buffer.alloc(Math.max(16, (options.size ?? 0) - fixed));
  return Buffer.concat([ftyp, box("mdat", mdatPayload), moov]);
}
