import { AppShell } from "@/components/shell";
import { CommandClient } from "@/components/command-client";

export default async function CommandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <CommandClient companyId={id} />
    </AppShell>
  );
}
