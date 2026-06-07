export type ContextFile = {
  path: string;
  estimatedTokens: number;
};

export type ContextChunk = {
  id: string;
  estimatedTokens: number;
  files: ContextFile[];
};

export function scoreContextFile(path: string) {
  if (/^(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/.test(path)) return 100;
  if (path === "prisma/schema.prisma") return 95;
  if (/^(app|pages|src|lib)\//.test(path) && /\.(ts|tsx|js|jsx|py|go|rb|rs)$/.test(path)) return 85;
  if (/\.(test|spec)\.(ts|tsx|js|jsx|py|go|rb|rs)$/.test(path)) return 80;
  if (/^(README|AGENTS|CLAUDE)\.md$/.test(path)) return 60;
  if (/^(dist|build|coverage|public)\//.test(path)) return 5;
  if (/\.(png|jpg|jpeg|gif|webp|mp4|mov|zip)$/.test(path)) return 1;
  return 30;
}

export function createContextChunkPlan(input: {
  files: ContextFile[];
  tokenBudget?: number;
  maxChunkTokens?: number;
}) {
  const tokenBudget = input.tokenBudget ?? 1_000_000;
  const maxChunkTokens = input.maxChunkTokens ?? 100_000;
  const selected: ContextFile[] = [];
  let totalSelectedTokens = 0;

  for (const file of [...input.files].sort(compareFiles)) {
    if (totalSelectedTokens + file.estimatedTokens > tokenBudget) continue;
    selected.push(file);
    totalSelectedTokens += file.estimatedTokens;
  }

  const chunks: ContextChunk[] = [];
  let current: ContextChunk = createChunk(1);
  for (const file of selected) {
    if (current.files.length > 0 && current.estimatedTokens + file.estimatedTokens > maxChunkTokens) {
      chunks.push(current);
      current = createChunk(chunks.length + 1);
    }
    current.files.push(file);
    current.estimatedTokens += file.estimatedTokens;
  }
  if (current.files.length > 0) chunks.push(current);

  return { tokenBudget, maxChunkTokens, totalSelectedTokens, chunks };
}

function compareFiles(a: ContextFile, b: ContextFile) {
  const scoreDiff = scoreContextFile(b.path) - scoreContextFile(a.path);
  if (scoreDiff !== 0) return scoreDiff;
  return a.path.localeCompare(b.path);
}

function createChunk(index: number): ContextChunk {
  return { id: `ctx_${String(index).padStart(3, "0")}`, estimatedTokens: 0, files: [] };
}
