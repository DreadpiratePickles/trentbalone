import { redirect } from "next/navigation";

export default async function AppSoloPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/companies/${id}/workbench?mode=agents`);
}
