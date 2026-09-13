/**
 * Where releases come from, and how bytes get from there to disk.
 *
 * The source is GitHub Releases for `DreadpiratePickles/trentbalone`. It can be replaced by
 * `insecureBaseUrl`, which the CLI sets ONLY when `--insecure-base-url` is passed explicitly; the
 * environment variable alone is never enough, so a poisoned shell profile cannot redirect an update.
 *
 * Transport rules, each one enforced here and nowhere else:
 *   - HTTPS only. A redirect must stay on an allowed host or the download is refused.
 *   - `Content-Length` must be present and must equal the bytes received.
 *   - Downloads land in a fresh 0700 temp directory as 0600 files.
 *   - The version and asset name are validated before they are interpolated into anything.
 */

import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { EXIT, TrentError } from "../errors/index.js";
import { assertValidVersion } from "./version.js";

export const RELEASE_REPO = "DreadpiratePickles/trentbalone";
export const GITHUB_API_HOST = "api.github.com";
export const GITHUB_HOSTS: readonly string[] = ["github.com", "objects.githubusercontent.com", GITHUB_API_HOST];

/** Hard ceiling on one artefact; the desktop bundle is the largest thing we ship. */
export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

export type Channel = "stable" | "prerelease";

export interface ReleaseOptions {
  /** Replaces GitHub entirely. Only the CLI's `--insecure-base-url` flag may populate this. */
  insecureBaseUrl?: string;
  /** PEM CA bundle for the insecure base URL (a test server). Ignored without one. */
  ca?: string;
}

export interface ResolvedRelease {
  version: string;
  tag: string;
  prerelease: boolean;
  assets: string[];
}

export interface FetchedArtifact {
  /** The downloaded file, inside `dir`. */
  path: string;
  /** Private temp directory (0700) that the caller removes when finished. */
  dir: string;
  bytes: number;
}

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._ +-]{0,127}$/;

function fail(message: string, target?: string, code: 2 | 3 | 5 = EXIT.PROVIDER): TrentError {
  return new TrentError({
    code,
    operation: "updater.release",
    message,
    ...(target === undefined ? {} : { target }),
  });
}

/** An asset name is one path segment of the release directory and nothing more. */
export function assertValidAssetName(name: string): string {
  if (!ASSET_NAME.test(name) || name.includes("..")) {
    throw fail("invalid release asset name", name.slice(0, 64), EXIT.USAGE);
  }
  return name;
}

interface Source {
  apiBase: URL;
  downloadBase: URL;
  allowedHosts: readonly string[];
  ca: string | undefined;
}

function source(options: ReleaseOptions): Source {
  if (options.insecureBaseUrl !== undefined) {
    let base: URL;
    try {
      base = new URL(options.insecureBaseUrl);
    } catch {
      throw fail("insecure base URL is not a valid URL", undefined, EXIT.USAGE);
    }
    if (base.protocol !== "https:") throw fail("release base URL must use https", base.protocol, EXIT.USAGE);
    const root = base.href.endsWith("/") ? base.href : `${base.href}/`;
    return {
      apiBase: new URL("api/", root),
      downloadBase: new URL("releases/download/", root),
      allowedHosts: [base.host],
      ca: options.ca,
    };
  }
  return {
    apiBase: new URL(`https://${GITHUB_API_HOST}/repos/${RELEASE_REPO}/`),
    downloadBase: new URL(`https://github.com/${RELEASE_REPO}/releases/download/`),
    allowedHosts: GITHUB_HOSTS,
    ca: undefined,
  };
}

/** Human-readable name of the release source, for dry-run output. */
export function describeSource(options: ReleaseOptions): string {
  return source(options).downloadBase.origin;
}

/** The download URL for one asset. Both inputs are validated here even if the caller already did. */
export function releaseDownloadUrl(name: string, version: string, options: ReleaseOptions = {}): URL {
  const clean = assertValidVersion(version);
  const asset = assertValidAssetName(name);
  return new URL(`v${clean}/${encodeURIComponent(asset)}`, source(options).downloadBase);
}

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Collected only when no sink is given (API responses); a streamed download leaves it empty. */
  body: Buffer;
  bytes: number;
  /** Set when the socket closed before `Content-Length` bytes arrived. */
  truncated: boolean;
}

type Sink = ((chunk: Buffer) => void) | undefined;

/** A socket that closed with fewer bytes than promised is a truncated download, named as such. */
function closedEarly(error: Error, url: URL, received: number, expected: number | undefined): TrentError {
  if (error instanceof TrentError) return error;
  if (expected !== undefined && received < expected) {
    return fail(`download was truncated: connection closed after ${received} of ${expected} bytes`, url.href);
  }
  return fail(`connection failed: ${error.message}`, url.host);
}

function requestOnce(url: URL, ca: string | undefined, signal: AbortSignal | undefined, sink: Sink): Promise<Response> {
  return new Promise((resolve, reject) => {
    let received = 0;
    let expected: number | undefined;
    const req = https.request(
      url,
      {
        method: "GET",
        headers: { "User-Agent": "trent-updater", Accept: "application/octet-stream, application/json" },
        // A fresh connection per request. Node's global agent pools keep-alive sockets, and a
        // pooled socket the server closed while the updater was busy (hdiutil, a build) fails
        // its next request with ECONNRESET / "socket hang up". The updater makes a handful of
        // requests; pooling buys nothing and cost the desktop install a flaky failure.
        agent: false,
        timeout: REQUEST_TIMEOUT_MS,
        ...(ca === undefined ? {} : { ca }),
        ...(signal === undefined ? {} : { signal }),
      },
      (res) => {
        const declared = res.headers["content-length"];
        expected = declared === undefined ? undefined : Number(declared);
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_ARTIFACT_BYTES) {
            req.destroy(fail("response exceeds the maximum artefact size"));
            return;
          }
          // A redirect body is never the artefact; only a 200 streams to disk.
          if (sink !== undefined && res.statusCode === 200) sink(chunk);
          else chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            bytes: received,
            truncated: !res.complete || (expected !== undefined && received !== expected),
          });
        });
        res.on("error", (error: Error) => reject(closedEarly(error, url, received, expected)));
        res.on("aborted", () => reject(closedEarly(new Error("aborted"), url, received, expected)));
      },
    );
    req.on("timeout", () => req.destroy(fail("request timed out", url.host)));
    req.on("error", (error: Error) => reject(closedEarly(error, url, received, expected)));
    req.end();
  });
}

/**
 * GET with manual redirect handling. Every hop must be HTTPS on an allowed host; a redirect anywhere
 * else is refused without being followed.
 */
async function get(url: URL, src: Source, signal: AbortSignal | undefined, sink?: Sink): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "https:") throw fail("refusing a non-https URL", current.origin);
    if (!src.allowedHosts.includes(current.host)) throw fail("refusing to contact a host outside the release source", current.host);
    const response = await requestOnce(current, src.ca, signal, sink);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (typeof location !== "string") throw fail("redirect without a Location header", current.href);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw fail("redirect to an unparseable URL", current.href);
      }
      if (next.protocol !== "https:" || !src.allowedHosts.includes(next.host)) {
        throw fail("refusing a redirect off the release host", `${current.host} -> ${next.host}`);
      }
      current = next;
      continue;
    }
    return response;
  }
  throw fail("too many redirects", url.href);
}

interface GitHubRelease {
  tag_name?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

function toResolved(entry: GitHubRelease): ResolvedRelease {
  const tag = typeof entry.tag_name === "string" ? entry.tag_name : "";
  const version = assertValidVersion(tag, "updater.resolve");
  const assets = Array.isArray(entry.assets)
    ? entry.assets
        .map((a) => (typeof a === "object" && a !== null && typeof (a as { name?: unknown }).name === "string" ? (a as { name: string }).name : ""))
        .filter((n) => n.length > 0)
    : [];
  return { version, tag, prerelease: entry.prerelease === true, assets };
}

/** The newest release on a channel. Stable ignores prereleases; prerelease takes the newest of all. */
export async function resolveLatest(channel: Channel, options: ReleaseOptions = {}, signal?: AbortSignal): Promise<ResolvedRelease> {
  const src = source(options);
  const url = new URL(channel === "stable" ? "releases/latest" : "releases", src.apiBase);
  const response = await get(url, src, signal);
  if (response.status !== 200) throw fail(`release lookup returned HTTP ${response.status}`, url.href);
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body.toString("utf8"));
  } catch {
    throw fail("release lookup returned invalid JSON", url.href);
  }
  if (channel === "stable") return toResolved(parsed as GitHubRelease);
  if (!Array.isArray(parsed) || parsed.length === 0) throw fail("no releases published", url.href);
  return toResolved(parsed[0] as GitHubRelease);
}

/** A fresh private directory: 0700, under the OS temp dir, mode enforced rather than assumed. */
export function privateTempDir(prefix = "trent-update-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * Download one release asset into a private temp directory. The returned path is the ONLY copy;
 * nothing is cached anywhere else, so the file verified is the file installed.
 */
export async function fetchArtifact(name: string, version: string, signal?: AbortSignal, options: ReleaseOptions = {}): Promise<FetchedArtifact> {
  const url = releaseDownloadUrl(name, version, options);
  const src = source(options);
  const dir = privateTempDir();
  const target = path.join(dir, assertValidAssetName(name));
  const fd = fs.openSync(target, "wx", 0o600);
  let ok = false;
  try {
    const response = await get(url, src, signal, (chunk) => {
      fs.writeSync(fd, chunk);
    });
    if (response.status !== 200) throw fail(`download returned HTTP ${response.status}`, url.href);
    if (response.headers["content-length"] === undefined) throw fail("download has no Content-Length; refusing an unbounded body", url.href);
    if (response.truncated) throw fail("download was truncated: received fewer bytes than Content-Length", url.href);
    fs.fsyncSync(fd);
    ok = true;
    return { path: target, dir, bytes: response.bytes };
  } finally {
    fs.closeSync(fd);
    if (!ok) fs.rmSync(dir, { recursive: true, force: true });
  }
}
