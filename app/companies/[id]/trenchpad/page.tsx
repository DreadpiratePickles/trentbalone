import { AppShell } from "@/components/shell";
import { TrenchpadClient } from "@/components/trenchpad-client";

export default async function TrenchpadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <TrenchpadClient companyId={id} />
    </AppShell>
  );
}
