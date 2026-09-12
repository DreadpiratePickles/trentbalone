import { AppShell } from "@/components/shell";
import { TrenchpadClient } from "@/components/trenchpad-client";

export default async function TrenchpadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id} wide>
      <TrenchpadClient companyId={id} />
    </AppShell>
  );
}
