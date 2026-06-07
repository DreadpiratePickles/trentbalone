import { AppShell } from "@/components/shell";
import { AgentsPageClient } from "@/components/sub-pages";

export default async function AgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <AgentsPageClient companyId={id} />
    </AppShell>
  );
}
