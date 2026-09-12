import { AppShell } from "@/components/shell";
import { QueuePageClient } from "@/components/sub-pages";

export default async function QueuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <QueuePageClient companyId={id} />
    </AppShell>
  );
}
