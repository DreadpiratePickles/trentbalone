import { ArtifactsPageClient } from "@/components/artifacts-client";
import { AppShell } from "@/components/shell";

export default async function ArtifactsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <ArtifactsPageClient companyId={id} />
    </AppShell>
  );
}
