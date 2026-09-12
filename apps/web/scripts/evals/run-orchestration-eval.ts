import { runOrchestrationEvalCommand } from "@/lib/orchestration-eval-runner";

async function main() {
  const result = await runOrchestrationEvalCommand(process.argv.slice(2));
  process.exitCode = result.exitCode;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
