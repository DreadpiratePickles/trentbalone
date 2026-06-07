import { PortfolioShell } from "@/components/shell";
import { CompaniesClient } from "@/components/companies-client";

export default function CompaniesPage() {
  return (
    <PortfolioShell>
      <CompaniesClient />
    </PortfolioShell>
  );
}
