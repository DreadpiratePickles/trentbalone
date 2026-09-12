/**
 * Run manifest: what went in, what came out, and whether the verifier agreed.
 *
 * Written for the same reason the rulebook demands executable evidence — "it worked" is not a
 * result, a recorded input version plus an output path plus a verifier exit code is. The manifest
 * is written atomically at 0600 in a 0700 directory because output paths and input versions leak
 * project structure, and because a manifest sitting next to a transcript should not be the weak
 * link in the directory.
 */

import path from "node:path";
import { atomicWriteFileSync, NODE_IO, type ConfigIO } from "../config/atomic-fs.js";
import { redactTranscript } from "./redact.js";
import { TrentError, EXIT } from "../errors/index.js";

export const RUN_MANIFEST_VERSION = 1;
export const MANIFEST_FILE_MODE = 0o600;
export const MANIFEST_DIR_MODE = 0o700;
export const MANIFEST_FILENAME = "manifest.json";

export interface VerifierResult {
  name: string;
  passed: boolean;
  exitCode: number;
  detail?: string;
}

export interface RunManifestInput {
  runId: string;
  stage?: string;
  /** Identifier (hash, version, mtime) per input artefact, keyed by path. */
  inputVersions: Record<string, string>;
  /** Versions of everything consulted but not authored: packages, models, reference docs. */
  referenceVersions: Record<string, string>;
  /** Paths this run produced or modified. */
  outputPaths: string[];
  verifier?: VerifierResult;
}

export interface RunManifest extends RunManifestInput {
  manifestVersion: number;
  createdAt: string;
}

function redactMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[redactTranscript(k)] = redactTranscript(String(v));
  }
  return out;
}

/**
 * Write `<dir>/manifest.json`. Returns the path written. The directory is created 0700 if absent.
 */
export function writeRunManifest(
  dir: string,
  input: RunManifestInput,
  io: ConfigIO = NODE_IO,
): string {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new TrentError({
      code: EXIT.USAGE,
      operation: "manifest.write",
      message: "a run manifest requires a runId",
    });
  }

  if (!io.existsSync(dir)) io.mkdirSync(dir, { recursive: true });
  try {
    io.chmodSync(dir, MANIFEST_DIR_MODE);
  } catch {
    // Best effort; an unchmoddable directory still gets a 0600 manifest inside it.
  }

  const manifest: RunManifest = {
    manifestVersion: RUN_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    runId: input.runId,
    inputVersions: redactMap(input.inputVersions),
    referenceVersions: redactMap(input.referenceVersions),
    outputPaths: input.outputPaths.map((p) => redactTranscript(p)),
  };
  if (input.stage !== undefined) manifest.stage = input.stage;
  if (input.verifier !== undefined) {
    const verifier: VerifierResult = {
      name: input.verifier.name,
      passed: input.verifier.passed,
      exitCode: input.verifier.exitCode,
    };
    if (input.verifier.detail !== undefined) {
      verifier.detail = redactTranscript(input.verifier.detail);
    }
    manifest.verifier = verifier;
  }

  const target = path.join(dir, MANIFEST_FILENAME);
  atomicWriteFileSync(io, target, JSON.stringify(manifest, null, 2), MANIFEST_FILE_MODE);
  return target;
}

export function readRunManifest(manifestPath: string, io: ConfigIO = NODE_IO): RunManifest {
  try {
    return JSON.parse(io.readFileSync(manifestPath, "utf8")) as RunManifest;
  } catch (err) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "manifest.read",
      message: "manifest is missing or unreadable",
      target: manifestPath,
      cause: err,
    });
  }
}
