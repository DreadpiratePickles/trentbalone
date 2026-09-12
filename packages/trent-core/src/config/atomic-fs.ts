import fs from "node:fs";

/**
 * The filesystem surface the config layer uses. Injectable so a test can simulate a
 * failure mid-write and prove no truncated or zero-byte file is ever left behind.
 */
export interface ConfigIO {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: "utf8"): string;
  writeFileSync(p: string, data: string, options?: { encoding?: "utf8"; mode?: number }): void;
  renameSync(from: string, to: string): void;
  chmodSync(p: string, mode: number): void;
  unlinkSync(p: string): void;
  mkdirSync(p: string, options: { recursive: true }): void;
  readdirSync(p: string, options: { withFileTypes: true }): fs.Dirent[];
}

export const NODE_IO: ConfigIO = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  writeFileSync: (p, data, options) => fs.writeFileSync(p, data, options ?? { encoding: "utf8" }),
  renameSync: (from, to) => fs.renameSync(from, to),
  chmodSync: (p, mode) => fs.chmodSync(p, mode),
  unlinkSync: (p) => fs.unlinkSync(p),
  mkdirSync: (p, options) => {
    fs.mkdirSync(p, options);
  },
  readdirSync: (p, options) => fs.readdirSync(p, options),
};

let tmpCounter = 0;

/**
 * Write-then-rename. The target file is only ever replaced by a fully written temp
 * file, so a crash or a failing writer leaves the previous content intact. `mode`, when
 * given, is applied on every write — not only when the file is created.
 */
export function atomicWriteFileSync(
  io: ConfigIO,
  filePath: string,
  data: string,
  mode?: number,
): void {
  const tmpPath = `${filePath}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    io.writeFileSync(tmpPath, data, { encoding: "utf8", mode: mode ?? 0o644 });
    if (mode !== undefined) io.chmodSync(tmpPath, mode);
    io.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (io.existsSync(tmpPath)) io.unlinkSync(tmpPath);
    } catch {
      // Cleanup is best effort; the original file is untouched either way.
    }
    throw err;
  }
  // Rename carries the temp file's mode across, but re-assert it so a pre-existing
  // permissive file can never survive a rewrite.
  if (mode !== undefined) io.chmodSync(filePath, mode);
}
