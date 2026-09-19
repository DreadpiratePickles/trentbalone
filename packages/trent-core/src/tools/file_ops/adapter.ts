/**
 * `file_ops`: Hermes's four file tools with their exact schemas, so skills written for Hermes port
 * unchanged — read_file(path; offset=1, limit<=2000), write_file(path, content),
 * patch(path, old_string, new_string; replace_all), search_files(pattern; target, path, file_glob,
 * limit=50, offset). Every operation is a shell command on the seat's sandbox; the path policy
 * runs on the host BEFORE the command is built, and the sandbox mount is the second wall.
 */
import fs from "node:fs";
import path from "node:path";
import { activeCheckpointSession } from "../../checkpoints/index.js";
import { intArg, parseAction, record, stringArg, type ToolSpec } from "../action.js";
import { createSandbox, shellQuote, type Sandbox } from "../sandbox.js";
import { SUMMARY_LIMIT, fitSummary } from "../spillover.js";
import type { ToolCallRecord, ToolContext, TrentToolAdapter } from "../types.js";
import { applySpans, fuzzyFind, unifiedDiff } from "./fuzzy.js";
import { PathPolicyError, isProtectedInstructionFile, resolveWorkspacePath, type ResolvedPath } from "./paths.js";

export const FILE_OPS_NAME = "file_ops";
export const FILE_OPS_SCOPES = ["file_ops", "read_file", "write_file", "patch", "search_files"];

const SPECS: readonly ToolSpec[] = [
  { name: "read_file", primary: "path", signature: ["path"] },
  { name: "write_file", primary: "path", signature: ["path", "content"] },
  { name: "patch", primary: "path", signature: ["path", "old_string", "new_string"] },
  { name: "search_files", primary: "pattern", signature: ["pattern"] },
];

/** Hermes `file_tools.py:47-109`: 2000 lines, 2000 chars per line, one budget per call. */
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const READ_BUDGET = SUMMARY_LIMIT - 400;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const WRITE_CHUNK = 48 * 1024;
const MAX_SEARCH_RESULTS = 500;
const PRUNE = String.raw`-type d \( -name .git -o -name node_modules \) -prune -o`;

export const FILE_OPS_INSTRUCTIONS =
  'file_ops reads and edits files in the repository workspace. toolCall.name "file_ops" (or the tool name); ' +
  'toolCall.action is "<tool> <json>": read_file {"path":"src/x.ts","offset":1,"limit":200} (LINE|content, ' +
  'follow next_offset to page), write_file {"path":"notes/a.md","content":"..."}, ' +
  'patch {"path":"src/x.ts","old_string":"exact existing text","new_string":"replacement","replace_all":false}, ' +
  'search_files {"pattern":"regex or *.glob","target":"content"|"files","path":".","file_glob":"*.ts","limit":50}. ' +
  'Paths are relative to the workspace root. Example: read_file {"path":"package.json"}.';

/** Measured against the lexical fallback embedder (no OPENAI_API_KEY): the shape that ranks first for file steps. */
export const FILE_OPS_ROUTING_TEXT =
  "read the file and report: package.json version, source code, config; write a file, patch source code, search the repository.";

function shellPath(resolved: ResolvedPath): string {
  return shellQuote(resolved.sandboxPath);
}

export function createFileOpsAdapter(ctx: ToolContext, sandbox: Sandbox = createSandbox(ctx)): TrentToolAdapter {
  const fail = (action: string, summary: string): ToolCallRecord => record(FILE_OPS_NAME, action, "failed", summary);
  const blocked = (action: string, summary: string): ToolCallRecord => record(FILE_OPS_NAME, action, "blocked", summary);

  async function readRaw(resolved: ResolvedPath): Promise<string> {
    const p = shellPath(resolved);
    const res = await sandbox.run(`if [ -d ${p} ]; then echo __TRENT_DIR__; exit 3; fi; head -c ${MAX_FILE_BYTES} ${p}`);
    if (res.exitCode !== 0) {
      if (res.stdout.startsWith("__TRENT_DIR__")) throw new Error(`${resolved.display} is a directory`);
      throw new Error(`cannot read ${resolved.display}: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    }
    return res.stdout;
  }

  async function writeRaw(resolved: ResolvedPath, content: string): Promise<void> {
    const p = shellPath(resolved);
    const dir = shellQuote(path.posix.dirname(resolved.sandboxPath));
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const steps = [`mkdir -p ${dir}`, `: > ${p}`];
    for (let at = 0; at < b64.length; at += WRITE_CHUNK) {
      steps.push(`printf %s ${shellQuote(b64.slice(at, at + WRITE_CHUNK))} | base64 -d >> ${p}`);
    }
    const res = await sandbox.run(steps.join(" && "));
    if (res.exitCode !== 0) throw new Error(`cannot write ${resolved.display}: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
  }

  /**
   * E1: ledgers the write BEFORE it lands, so the pre-image outlives the only copy of it.
   *
   * The bytes are read from the HOST path rather than through the sandbox: both backends address
   * the same file (Docker bind-mounts the workspace at /workspace), a host read has no stdout
   * budget to truncate it, and a truncated pre-image is worse than none — a rollback would restore
   * it as if it were the file. With no checkpoint session open this is a no-op, which is what
   * `checkpoints.enabled = false` means. A failure here fails the write: an unledgered write is
   * exactly the write `/rollback` would later fail to undo.
   */
  async function ledgerWrite(resolved: ResolvedPath, tool: string, after: Buffer | undefined): Promise<void> {
    const session = activeCheckpointSession();
    if (session === undefined || !session.store.enabled || resolved.inSpillover) return;
    const stat = fs.existsSync(resolved.hostPath) ? fs.statSync(resolved.hostPath) : undefined;
    if (stat?.isDirectory() === true) return;
    const before = stat === undefined ? undefined : fs.readFileSync(resolved.hostPath);
    session.record({ tool, path: resolved.hostPath, before, after });
  }

  async function readFile(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const target = stringArg(args, "path");
    if (!target) return fail(action, 'read_file needs {"path": "..."}');
    const resolved = resolveWorkspacePath(ctx, sandbox, target, "read");
    const text = await readRaw(resolved);
    const lines = text.replace(/\n$/, "").split("\n");
    const offset = intArg(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = intArg(args.limit, MAX_LINES, 1, MAX_LINES);
    if (offset > lines.length) return fail(action, `${resolved.display} has ${lines.length} lines; offset ${offset} is past the end`);
    const out: string[] = [];
    let used = 0;
    let index = offset - 1;
    for (; index < lines.length && index < offset - 1 + limit; index += 1) {
      const line = `${index + 1}|${lines[index]!.slice(0, MAX_LINE_CHARS)}`;
      if (used + line.length + 1 > READ_BUDGET && out.length > 0) break;
      out.push(line);
      used += line.length + 1;
    }
    const next = index < lines.length ? `\n[next_offset=${index + 1} of ${lines.length} lines]` : "";
    return record(FILE_OPS_NAME, action, "completed", `${resolved.display} (lines ${offset}-${index} of ${lines.length})\n${out.join("\n")}${next}`);
  }

  async function writeFile(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const target = stringArg(args, "path");
    const content = stringArg(args, "content");
    if (!target || content === undefined) return fail(action, 'write_file needs {"path": "...", "content": "..."}');
    const resolved = resolveWorkspacePath(ctx, sandbox, target, "write");
    await ledgerWrite(resolved, "write_file", Buffer.from(content, "utf8"));
    await writeRaw(resolved, content);
    return record(FILE_OPS_NAME, action, "completed", `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${resolved.display}`);
  }

  async function patch(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const target = stringArg(args, "path");
    const oldString = stringArg(args, "old_string");
    const newString = stringArg(args, "new_string");
    if (!target || oldString === undefined || newString === undefined) {
      return fail(action, 'patch needs {"path", "old_string", "new_string"} and optional "replace_all"');
    }
    if (oldString === "") return fail(action, "patch: old_string must not be empty");
    const replaceAll = args.replace_all === true;
    const resolved = resolveWorkspacePath(ctx, sandbox, target, "write");
    const before = await readRaw(resolved);
    const match = fuzzyFind(before, oldString, replaceAll);
    if (!match) return fail(action, `patch: old_string not found in ${resolved.display} (tried Hermes's nine matching strategies)`);
    if (match.spans.length > 1 && !replaceAll) {
      return fail(action, `patch: old_string matches ${match.spans.length} locations in ${resolved.display}; add more context or set replace_all=true`);
    }
    const after = applySpans(before, match.spans, newString);
    if (after === before) return fail(action, "patch: replacement produces no change");
    await ledgerWrite(resolved, "patch", Buffer.from(after, "utf8"));
    await writeRaw(resolved, after);
    const diff = unifiedDiff(resolved.display, before, after);
    const note = `Applied ${match.spans.length} replacement(s) via ${match.strategy} match in ${resolved.display}.\n`;
    return record(FILE_OPS_NAME, action, "completed", fitSummary(note + diff, ctx.profileDir, "patch"));
  }

  async function searchFiles(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const pattern = stringArg(args, "pattern");
    if (!pattern) return fail(action, 'search_files needs {"pattern": "..."} and optional target, path, file_glob, limit, offset');
    const target = args.target === "files" ? "files" : "content";
    const root = resolveWorkspacePath(ctx, sandbox, stringArg(args, "path") ?? ".", "read");
    const limit = intArg(args.limit, 50, 1, MAX_SEARCH_RESULTS);
    const offset = intArg(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const rootQ = shellPath(root);
    let command: string;
    if (target === "files") {
      const glob = /[*?[]/.test(pattern) ? pattern : `*${pattern}*`;
      command = `find ${rootQ} ${PRUNE} -type f -name ${shellQuote(glob)} -print`;
    } else {
      const fileGlob = stringArg(args, "file_glob");
      const name = fileGlob ? `-name ${shellQuote(fileGlob)} ` : "";
      command = `find ${rootQ} ${PRUNE} -type f ${name}-print0 | xargs -0 grep -nE -e ${shellQuote(pattern)} /dev/null; true`;
    }
    const res = await sandbox.run(command, { timeoutMs: 60_000 });
    const rows = res.stdout
      .split("\n")
      .filter((row) => row && !row.startsWith("Binary file"))
      .map((row) => (row.startsWith(`${sandbox.workspaceRoot}/`) ? row.slice(sandbox.workspaceRoot.length + 1) : row))
      .filter((row) => !isDenied(row));
    const page = rows.slice(offset, offset + limit);
    const more = rows.length > offset + limit ? `\n[next_offset=${offset + limit} of ${rows.length} results]` : "";
    const body = page.length ? page.join("\n") : "(no matches)";
    return record(FILE_OPS_NAME, action, "completed", fitSummary(`${rows.length} ${target} match(es) for ${pattern}\n${body}${more}`, ctx.profileDir, "search"));
  }

  /** A search row is `path[:line:text]`; the deny list applies to the path part. */
  function isDenied(row: string): boolean {
    const file = row.split(":")[0] ?? row;
    try {
      resolveWorkspacePath(ctx, sandbox, file, "read");
      return false;
    } catch {
      return true;
    }
  }

  function protectedTarget(args: Record<string, unknown>): boolean {
    const target = stringArg(args, "path");
    if (!target) return false;
    try {
      return isProtectedInstructionFile(resolveWorkspacePath(ctx, sandbox, target, "write").display);
    } catch {
      return false;
    }
  }

  return {
    name: FILE_OPS_NAME,
    scopes: [...FILE_OPS_SCOPES],
    availability: "real",
    instructions: FILE_OPS_INSTRUCTIONS,
    routingText: FILE_OPS_ROUTING_TEXT,
    async healthCheck() {
      return "connected";
    },
    estimateCost: () => 0,
    requiresApproval(action) {
      const parsed = parseAction(action, SPECS);
      if (parsed.error || (parsed.tool !== "write_file" && parsed.tool !== "patch")) return false;
      return protectedTarget(parsed.args) || ctx.autoApproveWrites !== true;
    },
    async dryRun(action) {
      const parsed = parseAction(action, SPECS);
      const target = stringArg(parsed.args, "path") ?? "?";
      const why = protectedTarget(parsed.args) ? "a protected instruction file" : "a workspace file";
      return record(FILE_OPS_NAME, action, "needs_approval", `${parsed.tool} would modify ${why}: ${target}. Approval required before execution.`);
    },
    async execute(action) {
      const parsed = parseAction(action, SPECS);
      if (parsed.error) return fail(action, parsed.error);
      try {
        switch (parsed.tool) {
          case "read_file":
            return await readFile(action, parsed.args);
          case "write_file":
            return await writeFile(action, parsed.args);
          case "patch":
            return await patch(action, parsed.args);
          default:
            return await searchFiles(action, parsed.args);
        }
      } catch (error) {
        if (error instanceof PathPolicyError) return blocked(action, `file_ops refused: ${error.message}`);
        return fail(action, `file_ops ${parsed.tool} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    cleanup: () => sandbox.cleanup(),
  };
}
