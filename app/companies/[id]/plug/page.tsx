import { AppShell } from "@/components/shell";
import { AgentPlugClient } from "@/components/agent-plug-client";
import { PlugsBrowser } from "@/components/plugs-browser";

export default async function PlugPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <AgentPlugClient companyId={id} />
      <PlugsBrowser companyId={id} />
    </AppShell>
  );
}
