import { AppShell } from "@/components/shell";
import { VaultGraphPageClient } from "@/components/vault-graph-client";

export default async function VaultGraphPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <VaultGraphPageClient companyId={id} />
    </AppShell>
  );
}
