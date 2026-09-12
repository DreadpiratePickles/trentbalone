import { AppShell } from "@/components/shell";
import { WikiPageTabs } from "@/components/wiki-page-tabs";

export default async function VaultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <WikiPageTabs companyId={id} />
    </AppShell>
  );
}
