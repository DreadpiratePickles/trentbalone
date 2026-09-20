/**
 * Which extractors `trent brain import` can use on this machine, on one line.
 *
 * Markdown, text and CSV need nothing. DOCX and XLSX are read by the wrapper's own ZIP and XML
 * readers, so they are always `builtin`. PDF is the one that can be missing: `pdftotext` (poppler)
 * is preferred when it is on PATH, `pdfjs-dist` is the fallback that resolves under Node and not
 * inside a compiled binary. A founder who is about to drop a folder of contracts in should learn
 * here, not from a failed import, that this machine cannot read a PDF and what to install.
 */
import { extractorAvailability } from "../../fleet-memory/ingest/extract.js";
import type { ExecProbe, ModuleResolver } from "../../fleet-memory/ingest/extract-pdf.js";
import { DEFAULT_PROBE_TIMEOUT_MS, runCommand } from "../probe.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

// Its own category: `DoctorRunner.test.ts` asserts one category per check, and "Brain" is the
// repository line.
const CATEGORY = "Brain Import";
const NAME = "Brain Import Extractors";

export interface BrainImportCheckOptions {
  /** The module seam, so a test can make `pdfjs-dist` unresolvable on a machine that has it. */
  readonly resolveModule?: ModuleResolver;
}

export function createBrainImportCheck(options: BrainImportCheckOptions = {}): DoctorCheck {
  return {
    id: "check_brain_import",
    name: NAME,
    category: CATEGORY,
    async run(ctx: DoctorContext): Promise<CheckResult> {
      const run = ctx.execImpl ?? runCommand;
      const timeoutMs = ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
      // The doctor's runner rejects when a binary cannot be spawned; the probe seam wants a code.
      const exec: ExecProbe = async (command, args) => {
        try {
          return await run(command, args, timeoutMs);
        } catch (err) {
          return { code: 127, stdout: "", stderr: (err as Error).message };
        }
      };
      const availability = await extractorAvailability({ exec, ...(options.resolveModule === undefined ? {} : { resolveModule: options.resolveModule }) });
      const line = `md, txt, csv: builtin; pdf: ${availability.pdf}; docx: ${availability.docx}; xlsx: ${availability.xlsx}`;
      const details = { ...availability };
      if (availability.pdf === "missing") {
        return {
          category: CATEGORY,
          name: NAME,
          status: "warn",
          message: `trent brain import can read ${line}. A PDF dropped into the brain will be refused until a PDF extractor is present.`,
          fixHint: "Install poppler so pdftotext is on PATH (brew install poppler, apt install poppler-utils), or run from a checkout where the pdfjs-dist package is installed (npm install).",
          details,
        };
      }
      return {
        category: CATEGORY,
        name: NAME,
        status: "ok",
        message: `trent brain import can read ${line}.`,
        details,
      };
    },
  };
}

export const checkBrainImport: DoctorCheck = createBrainImportCheck();
