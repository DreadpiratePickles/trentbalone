/**
 * Where a Chromium lives on this machine. `playwright-core` ships no browser, so the adapter
 * drives one that is already installed: `TRENT_BROWSER_PATH` first, then the usual executable
 * names on PATH, then the standard install locations per platform. Nothing is downloaded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PATH_NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "brave-browser", "microsoft-edge"];

const DARWIN_APPS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const LINUX_PATHS = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/snap/bin/chromium"];

const WINDOWS_SUFFIXES = [
  ["Google", "Chrome", "Application", "chrome.exe"],
  ["Chromium", "Application", "chrome.exe"],
  ["Microsoft", "Edge", "Application", "msedge.exe"],
];

export const CHROMIUM_INSTALL_HINT =
  "no Chromium was found. Install Google Chrome or Chromium, or point TRENT_BROWSER_PATH at a Chromium executable " +
  "(for example /Applications/Google Chrome.app/Contents/MacOS/Google Chrome or /usr/bin/chromium).";

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? [name, `${name}.exe`] : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      if (executable(file)) return file;
    }
  }
  return undefined;
}

function platformCandidates(env: NodeJS.ProcessEnv): string[] {
  if (process.platform === "darwin") return [...DARWIN_APPS, ...DARWIN_APPS.map((p) => path.join(os.homedir(), p))];
  if (process.platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    return roots.flatMap((root) => WINDOWS_SUFFIXES.map((parts) => path.join(root, ...parts)));
  }
  return LINUX_PATHS;
}

/** The first Chromium executable found, or null. Never launches anything. */
export function findChromium(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.TRENT_BROWSER_PATH?.trim();
  if (configured) return executable(configured) ? configured : null;
  for (const name of PATH_NAMES) {
    const found = onPath(name, env);
    if (found) return found;
  }
  for (const candidate of platformCandidates(env)) {
    if (executable(candidate)) return candidate;
  }
  return null;
}
