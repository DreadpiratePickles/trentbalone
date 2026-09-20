/**
 * The doctor's brain-import line: which extractors `trent brain import` can use on this machine.
 * A founder who drops a PDF into a profile with no PDF extractor must be told so here, before the
 * import fails, and told what to install.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigManager } from "../../config/ConfigManager.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { DoctorContext } from "../types.js";
import { checkBrainImport, createBrainImportCheck } from "./brain-import.js";

let home: string;
let configManager: ConfigManager;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-brain-import-")));
  configManager = new ConfigManager({ baseDir: home });
  configManager.ensureDirs();
  configManager.saveConfig({ ...DEFAULT_CONFIG });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const context = (): DoctorContext => ({ baseDir: home, profile: "default", configManager });
const notFound = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({ code: 127, stdout: "", stderr: "not found" });

describe("the brain import doctor check", () => {
  it("names every extractor and its backing on one line", async () => {
    const result = await checkBrainImport.run(context());
    expect(result.category).toBe("Brain Import");
    expect(["ok", "warn"]).toContain(result.status);
    expect(result.message).toMatch(/pdf: (pdftotext|pdfjs-dist|missing)/);
    expect(result.message).toContain("docx: builtin");
    expect(result.message).toContain("xlsx: builtin");
    expect(result.message).toContain("md, txt, csv");
    expect(result.details).toMatchObject({ docx: "builtin", xlsx: "builtin" });
  });

  it("reports pdfjs-dist when pdftotext is not on PATH but the package resolves", async () => {
    const check = createBrainImportCheck({ resolveModule: () => "/somewhere/pdfjs-dist/legacy/build/pdf.mjs" });
    const result = await check.run({ ...context(), execImpl: notFound });
    expect(result.status).toBe("ok");
    expect(result.message).toContain("pdf: pdfjs-dist");
  });

  it("warns, with the install hint, when no PDF extractor can be found", async () => {
    const check = createBrainImportCheck({ resolveModule: () => undefined });
    const result = await check.run({ ...context(), execImpl: notFound });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("pdf: missing");
    expect(result.message).toContain("docx: builtin");
    expect(result.fixHint).toMatch(/poppler|pdftotext/);
    expect(result.fixHint).toContain("pdfjs-dist");
    expect(result.details).toMatchObject({ pdf: "missing" });
  });
});
