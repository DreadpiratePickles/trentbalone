/**
 * `trent brain import`: files and directories in, `brain/docs/<slug>.md` out, through the brain's
 * one write path. What the founder drops in becomes knowledge a seat can retrieve with a citation.
 *
 * Rules, each one a line a test pins:
 *   - The source file's sha256 travels in the front matter. Re-importing an unchanged file is a
 *     no-op (no write, no commit, no index rebuild); a changed file replaces its doc, and its
 *     chunks follow because the index is derived from the file.
 *   - A doc is found again by its SOURCE PATH, so its slug, and therefore every chunk id a seat
 *     has ever cited, stays the same across re-imports. Two different files with one name get
 *     `report` and `report-2`.
 *   - The app's own path blocklist (`isIndexableWikiPath`, `apps/web/lib/trench-wiki.ts`) decides
 *     what may never be imported: `.env`, keys, `node_modules/`, `.git/`. It applies to a file
 *     named on the command line exactly as it does to one found in a directory walk. Dot-files
 *     and symlinks are skipped too; the walk never follows a link out of the directory it was given.
 *   - A path that does not exist is a usage error raised BEFORE anything is written. One file that
 *     cannot be extracted is `failed` in the report and does not stop the rest.
 *   - Dry run plans the same statuses and writes nothing.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isIndexableWikiPath } from "@/lib/trench-wiki";
import { BRAIN_DOCS_DIR, resolveBrainPath, type Brain, type BrainAuthor } from "../brain.js";
import { chunkBrainFile, docSlugOf } from "./brain-chunks.js";
import { chunkUnits } from "./chunk.js";
import { DOC_PROVENANCE, parseDocFile, renderDocFile, type DocMeta } from "./doc-file.js";
import { extractDocument, formatOf, type DocumentFormat, type ExtractOptions } from "./extract.js";

export type IngestStatus = "imported" | "updated" | "unchanged" | "failed";

export interface IngestFileResult {
  /** The absolute source path. */
  readonly source: string;
  readonly format: DocumentFormat;
  readonly slug: string;
  /** The brain-relative doc path. */
  readonly path: string;
  readonly status: IngestStatus;
  readonly reason?: string;
  readonly chunks?: number;
  readonly pages?: number;
  readonly sheets?: readonly string[];
  readonly warnings?: readonly string[];
  readonly committed?: boolean;
}

export interface IngestSkipped {
  readonly path: string;
  readonly reason: string;
}

export interface IngestResult {
  readonly dryRun: boolean;
  readonly files: readonly IngestFileResult[];
  /** What was seen and not imported: blocked paths, unsupported types, oversized files. */
  readonly skipped: readonly IngestSkipped[];
  readonly imported: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly failed: number;
}

export interface IngestOptions extends ExtractOptions {
  readonly brain: Brain;
  readonly paths: readonly string[];
  /** Glob-like patterns (`*` and `?`) matched against a file's name and its relative path. */
  readonly ignore?: readonly string[];
  readonly dryRun?: boolean;
  readonly now?: () => Date;
  /** Recorded as the writer of every commit; the founder by default. */
  readonly writer?: string;
  readonly maxFileBytes?: number;
}

/** A single file above this is refused: a founder's document is not a disk image. */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** How many skipped paths a report lists before it counts the rest. */
const MAX_SKIPPED_LISTED = 200;
/** Directory names never descended into, on top of the app's blocklist. */
const PRUNED_DIRECTORIES = new Set(["node_modules", ".git", ".next", "dist", "__pycache__"]);

export function docSlug(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName));
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return slug === "" ? "document" : slug;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** Why a path may not be imported, or `undefined` when it may. */
export function blockedReason(filePath: string, relative: string, ignore: readonly RegExp[]): string | undefined {
  const name = path.basename(filePath);
  if (name.startsWith(".")) return "dot-file";
  // The rule is applied to the path UNDER the directory the founder named, not to the absolute
  // prefix above it, so a home directory called `secrets` does not block every file inside it.
  const relativeSlashes = relative.split(path.sep).join("/");
  if (!isIndexableWikiPath(relativeSlashes) || !isIndexableWikiPath(name)) return "blocked path (env files, keys and dependency directories are never imported)";
  const hit = ignore.find((re) => re.test(name) || re.test(relativeSlashes));
  return hit === undefined ? undefined : `matches --ignore ${hit.source}`;
}

interface Candidate {
  readonly file: string;
  readonly relative: string;
}

/** Every regular file under `paths`, sorted, with what was skipped and why. */
export function collectImportFiles(paths: readonly string[], ignore: readonly string[] = []): { files: Candidate[]; skipped: IngestSkipped[] } {
  const patterns = ignore.map(globToRegExp);
  const files: Candidate[] = [];
  const skipped: IngestSkipped[] = [];
  const consider = (file: string, relative: string): void => {
    const blocked = blockedReason(file, relative, patterns);
    if (blocked !== undefined) {
      skipped.push({ path: file, reason: blocked });
      return;
    }
    if (formatOf(file) === undefined) {
      skipped.push({ path: file, reason: `unsupported file type "${path.extname(file) || "(no extension)"}"` });
      return;
    }
    files.push({ file, relative });
  };
  const walk = (dir: string, relative: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: dir, reason: `unreadable directory: ${(err as Error).message}` });
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = relative === "" ? entry.name : path.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push({ path: full, reason: "symbolic link" });
        continue;
      }
      if (entry.isDirectory()) {
        if (!PRUNED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) walk(full, rel);
        continue;
      }
      if (entry.isFile()) consider(full, rel);
    }
  };
  for (const given of paths) {
    // A path the founder typed is followed to its real location; links FOUND under it are not.
    let absolute: string;
    try {
      absolute = fs.realpathSync(path.resolve(given));
    } catch {
      throw new Error(`brain import: no such file or directory: ${given}`);
    }
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) walk(absolute, "");
    else consider(absolute, path.basename(absolute));
  }
  return { files, skipped };
}

interface ExistingDoc {
  readonly slug: string;
  readonly path: string;
  readonly meta: DocMeta;
}

/** Every well-formed doc under `docs/`, by slug. */
function existingDocs(brain: Brain): ExistingDoc[] {
  const out: ExistingDoc[] = [];
  for (const rel of brain.tree()) {
    const slug = docSlugOf(rel);
    if (slug === undefined) continue;
    const contents = brain.readFile(rel);
    if (contents === undefined) continue;
    const { meta } = parseDocFile(contents);
    if (meta !== undefined) out.push({ slug, path: rel, meta });
  }
  return out;
}

/** The doc already holding this source, else a slug no other doc uses. */
function slugFor(source: string, fileName: string, docs: readonly ExistingDoc[], taken: Set<string>): { slug: string; existing?: ExistingDoc } {
  const existing = docs.find((doc) => doc.meta.source === source);
  if (existing !== undefined) return { slug: existing.slug, existing };
  const base = docSlug(fileName);
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${String(n)}`;
  return { slug };
}

export async function ingestDocuments(options: IngestOptions): Promise<IngestResult> {
  const { brain } = options;
  const dryRun = options.dryRun === true;
  const now = options.now ?? (() => new Date());
  const author: BrainAuthor = { writer: options.writer ?? "human" };
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const { files, skipped } = collectImportFiles(options.paths, options.ignore ?? []);
  const docs = existingDocs(brain);
  const taken = new Set(docs.map((doc) => doc.slug));
  const results: IngestFileResult[] = [];

  for (const candidate of files) {
    const format = formatOf(candidate.file)!;
    const { slug, existing } = slugFor(candidate.file, candidate.file, docs, taken);
    taken.add(slug);
    const relativePath = `${BRAIN_DOCS_DIR}/${slug}.md`;
    const base = { source: candidate.file, format, slug, path: relativePath };
    let bytes: Buffer;
    try {
      const size = fs.statSync(candidate.file).size;
      if (size > maxBytes) {
        skipped.push({ path: candidate.file, reason: `larger than ${String(maxBytes)} bytes` });
        continue;
      }
      bytes = fs.readFileSync(candidate.file);
    } catch (err) {
      results.push({ ...base, status: "failed", reason: `unreadable: ${(err as Error).message}` });
      continue;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (existing !== undefined && existing.meta.sha256 === sha256) {
      results.push({ ...base, status: "unchanged", chunks: chunkBrainFile(existing.path, brain.readFile(existing.path) ?? "").chunks.length });
      continue;
    }
    const status: IngestStatus = existing === undefined ? "imported" : "updated";
    try {
      const extracted = await extractDocument(candidate.file, options);
      const meta: DocMeta = {
        title: extracted.title,
        source: candidate.file,
        format,
        sha256,
        imported_at: now().toISOString(),
        ...(extracted.pages === undefined ? {} : { pages: extracted.pages }),
        ...(extracted.sheets === undefined ? {} : { sheets: extracted.sheets }),
        provenance: DOC_PROVENANCE,
      };
      const chunks = chunkUnits(slug, extracted.units).length;
      const detail = {
        chunks,
        ...(extracted.pages === undefined ? {} : { pages: extracted.pages }),
        ...(extracted.sheets === undefined ? {} : { sheets: extracted.sheets }),
        ...(extracted.warnings.length === 0 ? {} : { warnings: extracted.warnings }),
      };
      if (dryRun) {
        results.push({ ...base, status, ...detail });
        continue;
      }
      const written = brain.writeFile(relativePath, renderDocFile(meta, extracted.units), author);
      results.push({ ...base, status, ...detail, committed: written.committed });
    } catch (err) {
      // The reason names the failure, never the file's bytes: an unreadable file may be anything.
      results.push({ ...base, status: "failed", reason: (err as Error).message.split("\n")[0] ?? "extraction failed" });
    }
  }

  const count = (status: IngestStatus): number => results.filter((r) => r.status === status).length;
  return {
    dryRun,
    files: results,
    skipped: skipped.length > MAX_SKIPPED_LISTED ? [...skipped.slice(0, MAX_SKIPPED_LISTED), { path: "...", reason: `${String(skipped.length - MAX_SKIPPED_LISTED)} more not listed` }] : skipped,
    imported: count("imported"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    failed: count("failed"),
  };
}

export interface BrainDocSummary {
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly source: string;
  readonly format: DocumentFormat;
  readonly sha256: string;
  readonly importedAt: string;
  readonly pages?: number;
  readonly sheets?: readonly string[];
  readonly chunks: number;
}

/** Every imported document with its chunk count, sorted by slug. Never a body. */
export function listBrainDocs(brain: Brain): BrainDocSummary[] {
  return existingDocs(brain)
    .map((doc) => {
      const chunked = chunkBrainFile(doc.path, brain.readFile(doc.path) ?? "");
      return {
        slug: doc.slug,
        path: doc.path,
        title: doc.meta.title,
        source: doc.meta.source,
        format: doc.meta.format,
        sha256: doc.meta.sha256,
        importedAt: doc.meta.imported_at,
        ...(doc.meta.pages === undefined ? {} : { pages: doc.meta.pages }),
        ...(doc.meta.sheets === undefined ? {} : { sheets: doc.meta.sheets }),
        chunks: chunked.chunks.length,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The doc path a slug or a `docs/<slug>.md` reference names; throws for anything else. */
export function resolveDocReference(profileDir: string, reference: string): { slug: string; path: string } {
  const raw = reference.trim();
  const asPath = raw.startsWith(`${BRAIN_DOCS_DIR}/`) ? raw : `${BRAIN_DOCS_DIR}/${raw}${raw.endsWith(".md") ? "" : ".md"}`;
  resolveBrainPath(profileDir, asPath);
  const slug = docSlugOf(asPath);
  if (slug === undefined) throw new Error(`brain docs: "${reference}" is not a document under ${BRAIN_DOCS_DIR}/`);
  return { slug, path: asPath };
}

export interface ForgetResult {
  readonly slug: string;
  readonly path: string;
  readonly removed: boolean;
  readonly committed: boolean;
}

/** Removes one imported document. Its chunks leave the index on the next rebuild. */
export function forgetBrainDoc(brain: Brain, reference: string, author: BrainAuthor): ForgetResult {
  const { slug, path: relativePath } = resolveDocReference(brain.profileDir, reference);
  const outcome = brain.removeFile(relativePath, author);
  return { slug, path: relativePath, removed: outcome.removed, committed: outcome.committed };
}
