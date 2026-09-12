import { AppShell } from "@/components/shell";
import { WorkbenchClient } from "@/components/workbench-client";
import { requireCompanyPageAccess } from "@/lib/page-auth";
import { resolveWorkbenchAgentsForCompany } from "@/lib/workbench-agents-server";

export default async function WorkbenchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCompanyPageAccess(id);
  const agents = await resolveWorkbenchAgentsForCompany(id);
  return (
    <AppShell companyId={id} wide>
      <WorkbenchClient companyId={id} agents={agents} />
    </AppShell>
  );
}
