import { AppSoloClient } from "@/components/app-solo-client";
import { AppShell } from "@/components/shell";

export default async function AppSoloPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <AppSoloClient companyId={id} />
    </AppShell>
  );
}
