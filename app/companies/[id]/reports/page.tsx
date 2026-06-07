import { AppShell } from "@/components/shell";
import { ReportsPageClient } from "@/components/sub-pages";

export default async function ReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <ReportsPageClient companyId={id} />
    </AppShell>
  );
}
