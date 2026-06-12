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
  if (errors.length > 0) {
    return errors.slice(0, 3).map((diagnostic) => {
      const position = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined;
      const location = position ? `(${position.line + 1},${position.character + 1}) ` : "";
      return `${location}${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    }).join("; ");
  }

  // RC3 (Fix Plan Slice 3): repair cycles repeatedly introduced duplicate
  // imports/identifiers (tester evidence: Button, Card, CardContent… imported
  // twice in src/App.tsx → typecheck/build failure + preview 500). transpile
  // does not catch these — detect them here so the bad write never lands.
  return duplicateImportSummary(content);
}

/**
 * Detects identifiers bound by more than one import statement.
 * Returns a short error summary, or undefined when imports are clean.
 */
export function duplicateImportSummary(content: string): string | undefined {
  const importRe = /^\s*import\s+(?:type\s+)?([^'"]+?)\s+from\s+['"][^'"]+['"]/gm;
  const seen = new Map<string, number>();
  const duplicates = new Set<string>();

  for (const match of content.matchAll(importRe)) {
    const clause = match[1].trim();
    for (const name of importClauseBindings(clause)) {
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      if (count > 1) duplicates.add(name);
    }
  }

  if (duplicates.size === 0) return undefined;
  const list = Array.from(duplicates).slice(0, 8).join(", ");
  return `duplicate import identifier(s): ${list} — each name may be imported only once; merge the import statements`;
}

/** Local binding names introduced by an import clause. */
function importClauseBindings(clause: string): string[] {
  const names: string[] = [];
  // Strip the named-imports block first, capturing its members.
  const named = clause.match(/\{([^}]*)\}/);
  if (named) {
    for (const part of named[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // "Foo as Bar" binds Bar; "type Foo" binds Foo.
      const asMatch = trimmed.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      const name = asMatch ? asMatch[1] : trimmed.replace(/^type\s+/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  const rest = clause.replace(/\{[^}]*\}/, "").trim();
  // Default import and/or namespace import: `Foo`, `Foo,`, `* as Bar`.
  const ns = rest.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (ns) names.push(ns[1]);
  const def = rest.replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "").replace(/,/g, " ").trim();
  if (def && /^[A-Za-z_$][\w$]*$/.test(def)) names.push(def);
  return names;
}
