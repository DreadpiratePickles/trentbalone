import { AppShell } from "@/components/shell";
import { AuditPageClient } from "@/components/sub-pages";

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <AuditPageClient companyId={id} />
    </AppShell>
  );
}
