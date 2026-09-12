import type { Metadata } from "next";
import { PublicCompanyClient } from "@/components/public-company-client";
import { store } from "@/lib/store";

interface Props {
  params: Promise<{ companySlug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { companySlug } = await params;
  const company = await store.getCompany(companySlug);

  if (!company || !company.publicVisibility) {
    return { title: "Not found · Trent" };
  }

  const title = `${company.name} · Trent`;
  const description = company.brief?.vision || `${company.name} is building with Trent.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: "Trent",
      type: "website",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default async function PublicCompanyPage({ params }: Props) {
  const { companySlug } = await params;
  return <PublicCompanyClient slug={companySlug} />;
}
