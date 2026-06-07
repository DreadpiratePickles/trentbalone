import { AgentMissionClient } from "@/components/agent-mission-client";
import { AppShell } from "@/components/shell";

export default async function MissionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <AgentMissionClient companyId={id} />
    </AppShell>
  );
}
