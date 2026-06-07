import { AppShell } from "@/components/shell";
import { SettingsPageClient } from "@/components/sub-pages";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <SettingsPageClient companyId={id} />
    </AppShell>
  );
}
