/**
 * workbench-build-editors.ts — runs scoped editor agents over the dependency waves.
 *
 * Each file in a wave is written by its own editor call (one file, scoped context).
 * Files within a wave have no inter-dependency, so they run in parallel under a
 * concurrency cap; waves run sequentially so a file always sees its dependencies
 * already written. The per-file `editFile` is injected (the build loop supplies
 * one that streams the executor model and writes through the provider + syntax
 * gate), which keeps this scheduler pure and unit-testable.
 */

import type { BuildPlanFile } from "@/lib/workbench-build-graph";

export type EditorResult = {
  path: string;
  ok: boolean;
  detail: string;
  bytes?: number;
};

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: cap }, runner));
  return results;
}

export async function runEditorWaves(input: {
  waves: string[][];
  files: BuildPlanFile[];
  editFile: (file: BuildPlanFile) => Promise<EditorResult>;
  concurrency?: number;
  /** Stop launching later waves once this many files have failed (default: no cap). */
  maxFailures?: number;
  onResult?: (result: EditorResult, waveIndex: number) => void;
}): Promise<{ results: EditorResult[]; aborted: boolean }> {
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const concurrency = input.concurrency ?? 4;
  const maxFailures = input.maxFailures ?? Infinity;
  const results: EditorResult[] = [];
  let failures = 0;

  for (let waveIndex = 0; waveIndex < input.waves.length; waveIndex++) {
    const wave = input.waves[waveIndex]
      .map((path) => byPath.get(path))
      .filter((f): f is BuildPlanFile => Boolean(f));

    const waveResults = await runWithConcurrency(wave, concurrency, async (file) => {
      try {
        return await input.editFile(file);
      } catch (err) {
        return {
          path: file.path,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        } satisfies EditorResult;
      }
    });

    for (const result of waveResults) {
      results.push(result);
      input.onResult?.(result, waveIndex);
      if (!result.ok) failures++;
    }

    if (failures >= maxFailures) {
      return { results, aborted: true };
    }
  }

  return { results, aborted: false };
}
