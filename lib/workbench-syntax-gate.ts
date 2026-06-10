/**
 * workbench-syntax-gate.ts
 *
 * Deterministic syntax validation for files the build agent writes into a
 * sandbox. A syntactically invalid .tsx written into a running Vite dev
 * server makes the module transform 500, React never mounts, and the user
 * sees a white screen — while the agent burns repair cycles editing other
 * files. Rejecting bad writes at the gate keeps the last working version on
 * disk and returns the exact parse error as actionable feedback.
 *
 * Purely syntactic (TypeScript transpileModule) — no type checking, no
 * project context needed, fast enough to run on every write.
 */

const CODE_FILE_RE = /\.(tsx|ts|jsx|js|mts|mjs|cts|cjs)$/i;

/**
 * Returns a short human-readable summary of syntax errors in `content`,
 * or undefined when the file parses cleanly (or is not a code/JSON file).
 */
export async function syntaxErrorSummary(filePath: string, content: string): Promise<string | undefined> {
  if (/\.json$/i.test(filePath)) {
    try {
      JSON.parse(content);
      return undefined;
    } catch (err) {
      return `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (!CODE_FILE_RE.test(filePath)) return undefined;

  const ts = (await import("typescript")).default;
  const result = ts.transpileModule(content, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });

  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length === 0) return undefined;

  return errors.slice(0, 3).map((diagnostic) => {
    const position = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : undefined;
    const location = position ? `(${position.line + 1},${position.character + 1}) ` : "";
    return `${location}${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  }).join("; ");
}
