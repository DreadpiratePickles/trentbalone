import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";
import { ProofDashboardView } from "@/components/proof-dashboard";
import { requireCompanyPageAccess } from "@/lib/page-auth";
import { loadProofDashboardFromDisk } from "@/lib/proof-dashboard";

export default async function ProofsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCompanyPageAccess(id);
  const dashboard = loadProofDashboardFromDisk();

  return (
    <AppShell companyId={id}>
      <div className="surface-page">
        <PageHeader
          eyebrow="proof"
          title="Proof dashboard"
          lead="Latest internal production and live-provider proof status. Missing artifacts are shown as not recorded; failed proofs stay visible until rerun."
        />
        <ProofDashboardView dashboard={dashboard} />
      </div>
    </AppShell>
  );
}
