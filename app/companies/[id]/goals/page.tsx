import { AppShell } from "@/components/shell";
import { GoalCockpit } from "@/components/goal-cockpit";

export default async function GoalsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <GoalCockpit companyId={id} />
    </AppShell>
  );
}
