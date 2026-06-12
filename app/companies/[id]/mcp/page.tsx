import { AppShell } from "@/components/shell";
import { McpServersPanel } from "@/components/mcp-servers-panel";

export default async function McpPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <McpServersPanel companyId={id} />
    </AppShell>
  );
}
