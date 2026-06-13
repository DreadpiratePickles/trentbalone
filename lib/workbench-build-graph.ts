/**
 * workbench-build-graph.ts — file-level dependency scheduling for multi-agent builds.
 *
 * The single-artifact build loop makes one model emit a whole app in one response,
 * which truncates on large projects and serializes all work. The multi-agent path
 * instead asks a planner for a file-level DAG, then writes independent files in
 * parallel "waves" (topological layers). This module is the pure scheduler: given
 * files with `dependsOn` edges, produce the ordered waves to execute.
 *
 * No I/O, no model calls — fully unit-testable.
 */

export type BuildPlanFile = {
  path: string;
  intent: string;
  dependsOn: string[];
};

export type BuildWaves = {
  /** Ordered layers; files within a layer have no dependency on each other. */
  waves: string[][];
  /** True if a dependency cycle was detected and broken. */
  hasCycle: boolean;
  /** dependsOn entries that pointed at files not in the plan (treated as pre-existing). */
  externalDeps: string[];
};

/**
 * Layer the files into dependency waves (Kahn's algorithm). Edges to paths not in
 * the plan are treated as already-satisfied (they are scaffold/pre-existing files).
 * A cycle is broken by emitting the still-blocked nodes as a final wave.
 */
export function planToWaves(files: BuildPlanFile[]): BuildWaves {
  const known = new Set(files.map((f) => f.path));
  const externalDeps = new Set<string>();

  // Build in-degree + adjacency over in-plan edges only.
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const file of files) {
    deps.set(file.path, new Set());
    if (!dependents.has(file.path)) dependents.set(file.path, new Set());
  }
  for (const file of files) {
    for (const dep of file.dependsOn ?? []) {
      if (dep === file.path) continue; // ignore self-edge
      if (!known.has(dep)) {
        externalDeps.add(dep);
        continue;
      }
      deps.get(file.path)!.add(dep);
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep)!.add(file.path);
    }
  }

  const waves: string[][] = [];
  const remaining = new Set(files.map((f) => f.path));

  while (remaining.size > 0) {
    // Ready = remaining files whose deps are all already emitted.
    const ready = [...remaining]
      .filter((path) => [...deps.get(path)!].every((dep) => !remaining.has(dep)))
      .sort(); // deterministic order
    if (ready.length === 0) {
      // Cycle: emit everything still blocked as one final wave and stop.
      waves.push([...remaining].sort());
      return { waves, hasCycle: true, externalDeps: [...externalDeps] };
    }
    for (const path of ready) remaining.delete(path);
    waves.push(ready);
  }

  return { waves, hasCycle: false, externalDeps: [...externalDeps] };
}
