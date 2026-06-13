import fs from "node:fs";
import { spawnSync } from "node:child_process";

export type EvalEnvEntry = [key: string, value: string];

export function loadAllowedEvalEnvFile(
  path: string,
  isAllowedKey: (key: string) => boolean,
): string[] {
  const entries = parseAllowedEvalEnvContent(readPossiblyRtfEnvFile(path), isAllowedKey);
  for (const [key, value] of entries) process.env[key] = value;
  return Array.from(new Set(entries.map(([key]) => key))).sort();
}

export function parseAllowedEvalEnvContent(
  content: string,
  isAllowedKey: (key: string) => boolean,
): EvalEnvEntry[] {
  const entries: EvalEnvEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*(?:=|:)\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!isAllowedKey(key)) continue;
    entries.push([key, normalizeEvalEnvValue(rawValue)]);
  }
  return entries;
}

function readPossiblyRtfEnvFile(path: string): string {
  const content = fs.readFileSync(path, "utf8");
  if (!content.trimStart().startsWith("{\\rtf")) return content;

  const result = spawnSync("textutil", ["-convert", "txt", "-stdout", path], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status === 0 && result.stdout.trim()) return result.stdout;
  return content;
}

function normalizeEvalEnvValue(value: string): string {
  let trimmed = value.trim();
  const hyperlink = trimmed.match(/HYPERLINK\s+"([^"]+)"/i);
  if (hyperlink?.[1]) return hyperlink[1].trim();

  trimmed = trimmed
    .replace(/\\[a-z*]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\\+$/g, "")
    .trim();

  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
