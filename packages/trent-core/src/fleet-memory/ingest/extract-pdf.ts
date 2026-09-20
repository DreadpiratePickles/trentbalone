/**
 * PDF text, one string per page, from whichever extractor this machine has:
 *
 *   1. `pdftotext` (poppler) when it is on PATH: the cheapest and most robust text layer reader
 *      there is, invoked with an ARGUMENT ARRAY and a deadline. Pages arrive separated by form
 *      feeds, which is what `-eol unix` plus poppler's page break convention gives.
 *   2. `pdfjs-dist` (Mozilla's pdf.js, Apache-2.0, pure JavaScript, no key, no network) otherwise.
 *      It is loaded through a dynamic import with a NON-LITERAL specifier so a bundler leaves it
 *      out: it resolves from `node_modules` under Node and reports `missing` inside a compiled
 *      binary rather than failing the build. Its Node build wants a canvas package for rendering
 *      and warns when none is present; text extraction never renders, so that warning is muted
 *      for the duration of the import and nothing else is.
 *
 * A page with no text layer (a scan) is returned as "" and named in `warnings`; nothing is OCRed
 * in this round, and nothing is invented for it. The doctor reports which of the two is in use
 * so a founder learns that a PDF cannot be read before the import says so.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export type PdfBacking = "pdftotext" | "pdfjs-dist";

export interface ExecOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The process seam: the CLI's `spawnSync` by default, the doctor's own runner when it probes. */
export type ExecProbe = (command: string, args: readonly string[]) => ExecOutcome | Promise<ExecOutcome>;

/** The module seam: `require.resolve` by default; a test hands in one that finds nothing. */
export type ModuleResolver = (specifier: string) => string | undefined;

export interface PdfExtractorOptions {
  readonly exec?: ExecProbe;
  readonly resolveModule?: ModuleResolver;
  readonly timeoutMs?: number;
}

export interface PdfExtractor {
  readonly backing: PdfBacking;
  /** Page texts, index 0 is page 1. A page with no text layer is "". */
  extract(file: string, bytes: Buffer): Promise<string[]>;
}

export const PDFJS_SPECIFIER = "pdfjs-dist/legacy/build/pdf.mjs";
const DEFAULT_TIMEOUT_MS = 60_000;
/** `pdftotext` writes the whole text to stdout; a long contract is a few MB, never more. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export const spawnProbe: ExecProbe = (command, args) => {
  try {
    const out = spawnSync(command, [...args], { encoding: "utf8", timeout: DEFAULT_TIMEOUT_MS, shell: false, maxBuffer: MAX_STDOUT_BYTES });
    if (out.error) return { code: 127, stdout: "", stderr: out.error.message };
    return { code: out.status ?? 1, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  } catch (err) {
    return { code: 127, stdout: "", stderr: (err as Error).message };
  }
};

export const requireResolver: ModuleResolver = (specifier) => {
  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    return undefined;
  }
};

async function probe(exec: ExecProbe, command: string, args: readonly string[]): Promise<ExecOutcome> {
  try {
    return await exec(command, args);
  } catch (err) {
    return { code: 127, stdout: "", stderr: (err as Error).message };
  }
}

/** True when `pdftotext -v` runs and names itself; the exit code differs between poppler builds. */
export async function pdftotextPresent(exec: ExecProbe = spawnProbe): Promise<boolean> {
  const out = await probe(exec, "pdftotext", ["-v"]);
  return out.code !== 127 && /pdftotext/i.test(`${out.stdout}\n${out.stderr}`);
}

function pdftotextExtractor(exec: ExecProbe): PdfExtractor {
  return {
    backing: "pdftotext",
    async extract(file) {
      // An absolute path never starts with `-`, so poppler's option parser cannot mistake it.
      const out = await probe(exec, "pdftotext", ["-enc", "UTF-8", "-eol", "unix", path.resolve(file), "-"]);
      if (out.code !== 0) throw new Error(`pdftotext exited ${String(out.code)}: ${out.stderr.trim().split("\n")[0] ?? ""}`.trim());
      const pages = out.stdout.split("\f");
      if (pages.length > 1 && pages[pages.length - 1]!.trim() === "") pages.pop();
      return pages.map((page) => page.replace(/[ \t]+\n/g, "\n").trim());
    },
  };
}

/** The slice of pdf.js this module calls. Typed here so the import stays non-literal. */
interface PdfjsModule {
  getDocument(source: { data: Uint8Array; useSystemFonts?: boolean; disableFontFace?: boolean; isEvalSupported?: boolean; verbosity?: number }): {
    promise: Promise<PdfjsDocument>;
    destroy(): Promise<void>;
  };
}

interface PdfjsTextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
  readonly width?: number;
  readonly transform?: readonly number[];
}

interface PdfjsDocument {
  readonly numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: readonly PdfjsTextItem[] }>; cleanup(): void }>;
}

/** pdf.js hands back positioned runs; lines and word gaps are recovered from their positions. */
export function joinTextItems(items: readonly PdfjsTextItem[]): string {
  let out = "";
  let previous: PdfjsTextItem | undefined;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    if (previous !== undefined) {
      const y = item.transform?.[5] ?? 0;
      const previousY = previous.transform?.[5] ?? 0;
      const sameLine = Math.abs(y - previousY) < 2;
      if (previous.hasEOL === true || !sameLine) {
        out += "\n";
      } else {
        const x = item.transform?.[4] ?? 0;
        const previousEnd = (previous.transform?.[4] ?? 0) + (previous.width ?? 0);
        if (x > previousEnd + 0.5 && !out.endsWith(" ") && !item.str.startsWith(" ")) out += " ";
      }
    }
    out += item.str;
    previous = item;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

let pdfjsLoading: Promise<PdfjsModule> | undefined;

async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsLoading ??= (async () => {
    // pdf.js warns at import time about the rendering canvas it cannot find. Rendering is never
    // used here, so those lines are muted for the import and console.warn is restored after it.
    const original = console.warn;
    console.warn = () => {};
    try {
      const specifier: string = PDFJS_SPECIFIER;
      return (await import(specifier)) as PdfjsModule;
    } finally {
      console.warn = original;
    }
  })();
  return pdfjsLoading;
}

function pdfjsExtractor(): PdfExtractor {
  return {
    backing: "pdfjs-dist",
    async extract(_file, bytes) {
      const pdfjs = await loadPdfjs();
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
      try {
        const document = await task.promise;
        const pages: string[] = [];
        for (let n = 1; n <= document.numPages; n += 1) {
          const page = await document.getPage(n);
          const content = await page.getTextContent();
          pages.push(joinTextItems(content.items));
          page.cleanup();
        }
        return pages;
      } finally {
        await task.destroy().catch(() => undefined);
      }
    },
  };
}

/** Which PDF extractor this machine can run, `undefined` when it has neither. */
export async function resolvePdfExtractor(options: PdfExtractorOptions = {}): Promise<PdfExtractor | undefined> {
  const exec = options.exec ?? spawnProbe;
  if (await pdftotextPresent(exec)) return pdftotextExtractor(exec);
  const resolve = options.resolveModule ?? requireResolver;
  if (resolve(PDFJS_SPECIFIER) !== undefined) return pdfjsExtractor();
  return undefined;
}
