import { AppShell } from "@/components/shell";
import { AutoresearchClient } from "@/components/autoresearch-client";
import { loadAutoresearchView } from "@/lib/self-improvement/autoresearch-read";

export default async function AutoresearchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await loadAutoresearchView(id);
  return (
    <AppShell companyId={id}>
      <AutoresearchClient companyId={id} initial={view} />
    </AppShell>
  );
}
