import { AppShell } from "@/components/shell";
import { CommandClient } from "@/components/command-client";

export default async function CommandPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const { q } = await searchParams;
  return (
    <AppShell companyId={id}>
      <CommandClient companyId={id} initialPrompt={typeof q === "string" ? q : undefined} />
    </AppShell>
  );
}
