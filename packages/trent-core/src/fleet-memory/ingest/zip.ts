/**
 * A ZIP reader on `node:zlib` alone, for the two office containers (DOCX and XLSX are ZIP archives
 * of XML parts). The central directory is read from the end of the file, each entry is located
 * through its local header, and `inflateRawSync` undoes method 8; method 0 is a plain copy. That
 * is the whole of what an office document needs, and it is why no ZIP dependency is added
 * (rulebook principle 15: the cheaper alternative is a hundred lines here).
 *
 * Refused, by name: encrypted entries, ZIP64 archives, and any entry that would inflate past the
 * bound below. A founder's contract is not four gigabytes, and an archive that claims to be is a
 * bomb, not a document.
 */
import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
/** The longest archive comment the format allows, which bounds the backwards search. */
const MAX_COMMENT_BYTES = 0xffff;
/** One inflated part may not exceed this. `word/document.xml` of a long contract is a few MB. */
export const MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024;

export interface ZipArchive {
  readonly names: readonly string[];
  /** The inflated bytes of one entry, or `undefined` when the archive has no such name. */
  read(name: string): Buffer | undefined;
}

interface Entry {
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  readonly encrypted: boolean;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const floor = Math.max(0, bytes.length - 22 - MAX_COMMENT_BYTES);
  for (let at = bytes.length - 22; at >= floor; at -= 1) {
    if (bytes.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  throw new Error("not a ZIP archive: no end-of-central-directory record");
}

export function openZip(bytes: Buffer): ZipArchive {
  if (bytes.length < 22) throw new Error("not a ZIP archive: too short");
  const end = findEndOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER) throw new Error("ZIP64 archives are not supported");
  if (directoryOffset + directorySize > bytes.length) throw new Error("not a ZIP archive: the central directory lies past the end of the file");

  const entries = new Map<string, Entry>();
  let at = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_FILE_HEADER) throw new Error("not a ZIP archive: a central directory entry is malformed");
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localOffset = bytes.readUInt32LE(at + 42);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    if (size === ZIP64_MARKER || compressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) throw new Error("ZIP64 archives are not supported");
    entries.set(name, { method, compressedSize, size, localOffset, encrypted: (flags & 0x1) !== 0 });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name);
      if (entry === undefined) return undefined;
      if (entry.encrypted) throw new Error(`the archive entry ${name} is encrypted`);
      if (entry.size > MAX_ZIP_ENTRY_BYTES) throw new Error(`the archive entry ${name} would inflate past ${String(MAX_ZIP_ENTRY_BYTES)} bytes`);
      const local = entry.localOffset;
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL_FILE_HEADER) throw new Error(`the archive entry ${name} has a malformed local header`);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const stop = start + entry.compressedSize;
      if (stop > bytes.length) throw new Error(`the archive entry ${name} runs past the end of the file`);
      const data = bytes.subarray(start, stop);
      if (entry.method === 0) return Buffer.from(data);
      if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
      throw new Error(`the archive entry ${name} uses compression method ${String(entry.method)}, which is not deflate`);
    },
  };
}
