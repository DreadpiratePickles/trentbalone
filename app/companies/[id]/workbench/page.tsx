import { AppShell } from "@/components/shell";
import { WorkbenchClient } from "@/components/workbench-client";

export default async function WorkbenchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <WorkbenchClient companyId={id} />
    </AppShell>
  );
}
