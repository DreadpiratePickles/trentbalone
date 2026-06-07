import { AppShell } from "@/components/shell";
import { IntegrationsPageClient } from "@/components/sub-pages";

export default async function IntegrationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <IntegrationsPageClient companyId={id} />
    </AppShell>
  );
}
