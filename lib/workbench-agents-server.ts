import { resolveSeatToolContracts } from "@/lib/seat-tool-contracts";
import { buildWorkbenchAgentsFromContracts, type WorkbenchAgent } from "@/lib/workbench-agents";

export async function resolveWorkbenchAgentsForCompany(companyId: string): Promise<WorkbenchAgent[]> {
  return buildWorkbenchAgentsFromContracts(await resolveSeatToolContracts(companyId));
}
