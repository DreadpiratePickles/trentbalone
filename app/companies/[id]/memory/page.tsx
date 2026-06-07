import { AppShell } from "@/components/shell";
import { MemoryPageClient } from "@/components/sub-pages";

export default async function MemoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <MemoryPageClient companyId={id} />
    </AppShell>
  );
}
