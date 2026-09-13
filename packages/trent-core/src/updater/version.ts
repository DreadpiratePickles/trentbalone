/**
 * Strict release-version handling. A version string reaches a URL or a filesystem path only after
 * `assertValidVersion` has accepted it, so `../../etc` is rejected before any request is made.
 */

import { EXIT, TrentError } from "../errors/index.js";

export const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/** Validate and normalise (strip the `v`). Throws a usage error on anything else. */
export function assertValidVersion(input: string, operation = "updater.version"): string {
  if (typeof input !== "string" || !VERSION_PATTERN.test(input)) {
    throw new TrentError({
      code: EXIT.USAGE,
      operation,
      message: "invalid release version; expected MAJOR.MINOR.PATCH with an optional prerelease tag",
      target: input.length > 64 ? `${input.slice(0, 64)}...` : input,
    });
  }
  return input.startsWith("v") ? input.slice(1) : input;
}

interface Parsed {
  core: [number, number, number];
  prerelease: string[] | undefined;
}

function parse(version: string): Parsed {
  const clean = assertValidVersion(version);
  const match = VERSION_PATTERN.exec(clean);
  if (match === null) throw new Error("unreachable: validated version failed to parse");
  const core: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const tag = match[4];
  return { core, prerelease: tag === undefined ? undefined : tag.slice(1).split(".") };
}

function compareIdentifiers(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Math.sign(Number(a) - Number(b));
  if (na) return -1; // numeric identifiers sort before alphanumeric ones
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence: -1 when a < b, 0 when equal, 1 when a > b. A prerelease sorts below its release. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = Math.sign((pa.core[i] ?? 0) - (pb.core[i] ?? 0));
    if (diff !== 0) return diff as -1 | 1;
  }
  if (pa.prerelease === undefined && pb.prerelease === undefined) return 0;
  if (pa.prerelease === undefined) return 1;
  if (pb.prerelease === undefined) return -1;
  const length = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const diff = compareIdentifiers(ia, ib);
    if (diff !== 0) return diff as -1 | 1;
  }
  return 0;
}
