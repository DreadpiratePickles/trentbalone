import { AppShell } from "@/components/shell";
import { AgentOpsClient } from "@/components/agent-ops-client";

export default async function OpsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <AgentOpsClient companyId={id} />
    </AppShell>
  );
}
