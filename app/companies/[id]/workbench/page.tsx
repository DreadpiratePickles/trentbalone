import { AppShell } from "@/components/shell";
import { WorkbenchClient } from "@/components/workbench-client";
import { resolveWorkbenchAgentsForCompany } from "@/lib/workbench-agents-server";

export default async function WorkbenchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agents = await resolveWorkbenchAgentsForCompany(id);
  return (
    <AppShell companyId={id}>
      <WorkbenchClient companyId={id} agents={agents} />
    </AppShell>
  );
}
