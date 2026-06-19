import { AppShell } from "@/components/shell";
import { AutoresearchClient } from "@/components/autoresearch-client";
import { requireCompanyPageAccess } from "@/lib/page-auth";
import { loadAutoresearchView } from "@/lib/self-improvement/autoresearch-read";

export default async function AutoresearchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCompanyPageAccess(id);
  const view = await loadAutoresearchView(id);
  return (
    <AppShell companyId={id}>
      <AutoresearchClient companyId={id} initial={view} />
    </AppShell>
  );
}
