/**
 * W5 — a gzipped ustar archive of one directory, written without a `tar` binary.
 *
 * `hermes profile import` reads the archive with Python's `tarfile` and accepts directories and
 * regular files only, under exactly one top-level directory that names the profile
 * (`hermes_cli/archive_safe.py`, `hermes_cli/profiles.py`). This writer produces exactly that:
 * entries sorted by path, a directory entry per directory, fixed ownership and a fixed
 * modification time, so the same tree gives the same bytes twice. Headers are POSIX ustar with the
 * `prefix` field for a path over 100 bytes; a path that fits neither is refused rather than
 * truncated.
 */
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

/** Splits an archive path into ustar `prefix` and `name`, or throws when no split fits. */
function splitName(archivePath: string): { name: string; prefix: string } {
  const bytes = Buffer.byteLength(archivePath, "utf8");
  if (bytes <= NAME_MAX) return { name: archivePath, prefix: "" };
  const parts = archivePath.split("/");
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= PREFIX_MAX && Buffer.byteLength(name, "utf8") <= NAME_MAX) return { name, prefix };
  }
  throw new Error(`archive path too long for ustar: ${archivePath}`);
}

function header(archivePath: string, size: number, directory: boolean): Buffer {
  const { name, prefix } = splitName(archivePath);
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name, 0, NAME_MAX, "utf8");
  octal(directory ? 0o755 : 0o644, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136);
  Buffer.from("        ", "ascii").copy(block, 148);
  block.write(directory ? "5" : "0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(prefix, 345, PREFIX_MAX, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(block, 148);
  return block;
}

/** Every path under `dir`, relative to it with `/` separators, directories first, sorted. */
function walk(dir: string, relative: string, include: (relative: string) => boolean, out: { relative: string; directory: boolean }[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (!include(rel)) continue;
    if (entry.isDirectory()) {
      out.push({ relative: rel, directory: true });
      walk(path.join(dir, entry.name), rel, include, out);
    } else if (entry.isFile()) {
      out.push({ relative: rel, directory: false });
    }
    // Symlinks and special files are left out: the importer refuses them anyway.
  }
}

export interface TarGzOptions {
  /** The one top-level directory in the archive. */
  readonly rootName: string;
  /** Which `dir`-relative paths to include; a directory refused is not descended. */
  readonly include?: (relative: string) => boolean;
}

/** The gzipped archive of `dir` under `rootName/`. */
export function tarGzDirectory(dir: string, options: TarGzOptions): Buffer {
  const include = options.include ?? (() => true);
  const entries: { relative: string; directory: boolean }[] = [];
  walk(dir, "", include, entries);
  const blocks: Buffer[] = [header(`${options.rootName}/`, 0, true)];
  for (const entry of entries) {
    const archivePath = `${options.rootName}/${entry.relative}`;
    if (entry.directory) {
      blocks.push(header(`${archivePath}/`, 0, true));
      continue;
    }
    const content = fs.readFileSync(path.join(dir, entry.relative));
    blocks.push(header(archivePath, content.length, false), content);
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}
