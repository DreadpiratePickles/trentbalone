import { AppShell } from "@/components/shell";
import { BudgetsPageClient } from "@/components/sub-pages";

export default async function BudgetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <BudgetsPageClient companyId={id} />
    </AppShell>
  );
}
