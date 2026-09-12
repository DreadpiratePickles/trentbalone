import { findPlugBySlug } from "@/lib/plug/registry";
import { runPlugExecution } from "@/lib/plug/execution-runner";
import { store } from "@/lib/store";

type Args = {
  slug: string;
  companyId: string;
  objective: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plug = findPlugBySlug(args.slug);
  if (!plug) throw new Error(`Plug not found: ${args.slug}`);

  const companies = await store.listCompanies();
  const companyExists = companies.some((company) => company.id === args.companyId);
  if (!companyExists) throw new Error(`Company not found: ${args.companyId}`);

  const result = await runPlugExecution({
    companyId: args.companyId,
    plug,
    objective: args.objective,
    variables: { company: companies.find((company) => company.id === args.companyId)?.name ?? args.companyId },
  });

  console.log(JSON.stringify({
    passed: result.status === "completed" && result.launch.ready,
    status: result.status,
    companyId: result.companyId,
    sessionId: result.sessionId,
    plug: result.plug,
    toolCalls: result.toolCalls.map((call) => ({
      toolId: call.toolId,
      action: call.action,
      status: call.status,
      approvalGate: call.approvalGate,
      artifactId: call.artifactId,
      reportId: call.reportId,
    })),
    launch: {
      ready: result.launch.ready,
      evidence: result.launch.evidence,
      requirements: result.launch.requirements,
      costEstimateCents: result.launch.costEstimateCents,
    },
    memoryNamespace: result.memoryNamespace,
  }, null, 2));

  process.exitCode = result.status === "completed" && result.launch.ready ? 0 : 1;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    slug: "weekly-ops-review",
    companyId: "company_trent_demo",
    objective: "Run the selected Agent Plug and produce execution evidence.",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--slug") {
      if (!next) throw new Error("--slug requires a value");
      args.slug = next;
      i++;
      continue;
    }
    if (arg === "--company-id") {
      if (!next) throw new Error("--company-id requires a value");
      args.companyId = next;
      i++;
      continue;
    }
    if (arg === "--objective") {
      if (!next) throw new Error("--objective requires a value");
      args.objective = next;
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log([
    "Usage: npm run agent-plug:eval:e2e -- --slug weekly-ops-review --company-id company_trent_demo --objective \"Prepare weekly CEO review\"",
    "",
    "Runs one selected Agent Plug through Trent's typed local Plug execution runtime.",
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
