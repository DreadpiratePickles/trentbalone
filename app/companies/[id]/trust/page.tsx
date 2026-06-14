import { AppShell } from "@/components/shell";
import { TrustPanelPageClient } from "@/components/trust-panel-page-client";

export default async function TrustPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <TrustPanelPageClient companyId={id} />
    </AppShell>
  );
}
