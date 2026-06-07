import { AppShell } from "@/components/shell";
import { CyclesPageClient } from "@/components/sub-pages";

export default async function CyclesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <CyclesPageClient companyId={id} />
    </AppShell>
  );
}
