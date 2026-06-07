import { AppShell } from "@/components/shell";
import { CompanyDashboardClient } from "@/components/company-dashboard-client";

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell companyId={id}>
      <CompanyDashboardClient companyId={id} />
    </AppShell>
  );
}
