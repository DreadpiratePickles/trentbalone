/**
 * Live preview URL management for workbench sessions.
 *
 * For mock_local: probe common dev-server ports and return http://localhost:PORT.
 * For production: wrap cloudflared tunnel to expose a local port publicly.
 */

import { execFile, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import * as net from "net";
import * as fs from "fs/promises";
import * as path from "path";

const execFileAsync = promisify(execFile);

// ── Port probing ──────────────────────────────────────────────────────────────

/** Common dev-server ports, checked in priority order. */
const DEV_SERVER_PORTS = [3000, 5173, 4200, 3001, 8080, 4000, 8000, 5000];

export function getWorkbenchPreviewCandidatePorts(): number[] {
  const hostAppPort = Number.parseInt(process.env.PORT ?? "", 10);
  return DEV_SERVER_PORTS.filter((port) => port !== hostAppPort);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isHostAppPreviewUrl(
  previewUrl: string,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean {
  const hostAppPort = Number.parseInt(env.PORT ?? "", 10);
  if (!hostAppPort) return false;
  try {
    const parsed = new URL(previewUrl);
    return isLoopbackHost(parsed.hostname) && Number(parsed.port || "80") === hostAppPort;
  } catch {
    return false;
  }
}

export function isLocalPreviewUrl(previewUrl: string): boolean {
  try {
    const parsed = new URL(previewUrl);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Return true if something is listening on localhost:port within timeoutMs.
 */
export async function probePort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const done = (result: boolean) => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(result); }
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Guess the dev-server port from package.json scripts (e.g. "next dev -p 4000").
 * Falls back to scanning common ports.
 */
export async function detectDevServerPort(workdir: string): Promise<number | undefined> {
  // Try to parse an explicit port from package.json scripts
  try {
    const raw = await fs.readFile(path.join(workdir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const dev = pkg.scripts?.dev ?? pkg.scripts?.start ?? "";
    const portMatch = dev.match(/(?:--port|-p)\s+(\d{4,5})/);
    if (portMatch) {
      const candidate = parseInt(portMatch[1], 10);
      if (await probePort(candidate)) return candidate;
    }
  } catch { /* no package.json or parse error — fall through */ }

  for (const port of getWorkbenchPreviewCandidatePorts()) {
    if (await probePort(port)) return port;
  }
  return undefined;
}

/**
 * Return http://localhost:PORT if a dev server is running, otherwise undefined.
 */
export async function getLocalPreviewUrl(workdir?: string): Promise<string | undefined> {
  const port = workdir
    ? await detectDevServerPort(workdir)
    : await (async () => {
        for (const p of getWorkbenchPreviewCandidatePorts()) {
          if (await probePort(p)) return p;
        }
        return undefined;
      })();
  return port ? `http://localhost:${port}` : undefined;
}

// ── Cloudflare Tunnel (cloudflared) ───────────────────────────────────────────

export type TunnelHandle = {
  /** The public HTTPS URL assigned by Cloudflare. */
  url: string;
  /** Stop the tunnel subprocess. */
  stop: () => Promise<void>;
};

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TUNNEL_STARTUP_TIMEOUT_MS = 20_000;

/**
 * Start a cloudflared quick tunnel for localPort.
 * Requires `cloudflared` to be installed and on PATH.
 * Throws if the tunnel URL is not assigned within TUNNEL_STARTUP_TIMEOUT_MS.
 */
export async function startCloudflaredTunnel(localPort: number): Promise<TunnelHandle> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;

    try {
      proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${localPort}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new Error(`Failed to spawn cloudflared: ${(err as Error).message}`));
      return;
    }

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error("cloudflared did not emit a tunnel URL within the timeout"));
      }
    }, TUNNEL_STARTUP_TIMEOUT_MS);

    const handleLine = (line: string) => {
      const match = line.match(TUNNEL_URL_RE);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        const url = match[0];
        resolve({
          url,
          stop: () => new Promise<void>((res) => {
            proc.once("close", () => res());
            proc.kill();
          }),
        });
      }
    };

    proc.stdout?.on("data", (chunk: Buffer) => chunk.toString().split("\n").forEach(handleLine));
    proc.stderr?.on("data", (chunk: Buffer) => chunk.toString().split("\n").forEach(handleLine));

    proc.on("error", (err) => {
      if (!resolved) { clearTimeout(timer); reject(err); }
    });

    proc.on("close", (code) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited with code ${code} before emitting a URL`));
      }
    });
  });
}

/**
 * Check whether cloudflared is available on PATH.
 */
export async function isCloudflaredAvailable(): Promise<boolean> {
  try {
    await execFileAsync("cloudflared", ["--version"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

// ── High-level preview URL resolver ──────────────────────────────────────────

export type PreviewUrlOptions = {
  /** Override port instead of auto-detecting. */
  port?: number;
  /** If true, start a cloudflared tunnel and return the public URL. */
  tunnel?: boolean;
  /** Project workdir for package.json port parsing. */
  workdir?: string;
};

/**
 * Resolve the preview URL for a session:
 * 1. Find or probe the running dev-server port.
 * 2. Optionally wrap with a cloudflared quick tunnel.
 */
export async function resolvePreviewUrl(
  options?: PreviewUrlOptions
): Promise<{ url: string; tunnelHandle?: TunnelHandle } | undefined> {
  let port = options?.port;

  if (!port) {
    const detected = options?.workdir
      ? await detectDevServerPort(options.workdir)
      : await (async () => {
          for (const p of getWorkbenchPreviewCandidatePorts()) { if (await probePort(p)) return p; }
          return undefined;
        })();
    if (!detected) return undefined;
    port = detected;
  }

  const localUrl = `http://localhost:${port}`;

  if (options?.tunnel) {
    if (!(await isCloudflaredAvailable())) {
      return { url: localUrl };
    }
    const handle = await startCloudflaredTunnel(port);
    return { url: handle.url, tunnelHandle: handle };
  }

  return { url: localUrl };
}
