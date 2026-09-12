import { AppShell } from "@/components/shell";
import { ApprovalsPageClient } from "@/components/sub-pages";

export default async function ApprovalsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <ApprovalsPageClient companyId={id} />
    </AppShell>
  );
}
