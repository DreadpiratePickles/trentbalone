/**
 * scripts/seed-db.ts
 *
 * Deterministic seed for local development.
 * Creates a demo company + user + agents so the UI is immediately usable.
 *
 * Usage:
 *   npx tsx scripts/seed-db.ts
 *   DATABASE_URL=file:./dev.db npx tsx scripts/seed-db.ts
 */

import { db } from "../lib/db";
import { createSeedState } from "../lib/seed";
import { store } from "../lib/store";

async function run() {
  console.log("[seed] Checking existing data...");

  const existingCompany = await db.company.findFirst({ where: { slug: "trent-demo" } });
  if (existingCompany) {
    console.log("[seed] Demo company already exists — skipping. Use --force to re-seed.");
    if (!process.argv.includes("--force")) {
      process.exit(0);
    }
    console.log("[seed] --force detected — clearing demo data...");
    await db.company.delete({ where: { id: existingCompany.id } });
  }

  console.log("[seed] Creating demo user...");
  const user = await db.user.upsert({
    where: { email: "demo@trent.local" },
    create: {
      id: "user_demo",
      email: "demo@trent.local",
      name: "Demo Founder",
    },
    update: {}
  });

  console.log("[seed] Creating demo company via store...");
  const seedState = createSeedState();
  const company = seedState.companies[0];
  if (!company) throw new Error("No company in seed state");

  // Create company directly in DB (bypassing mem-store since we target SQLite)
  await db.company.create({
    data: {
      id: company.id,
      name: company.name,
      slug: company.slug,
      website: company.website,
      status: company.status,
      autonomyLevel: company.autonomyLevel,
      publicVisibility: company.publicVisibility,
      publicSubdomain: company.publicSubdomain,
      timezone: company.timezone,
      budgetCents: company.budgetCents,
      cycleFrequency: company.cycleFrequency,
      brief: JSON.stringify(company.brief),
      metrics: JSON.stringify(company.metrics),
    }
  });

  // Add user as company owner
  await db.companyMember.create({
    data: {
      userId: user.id,
      companyId: company.id,
      role: "owner",
      permissions: "[]"
    }
  });

  // Create default agents
  for (const agent of seedState.agents) {
    await db.agent.create({
      data: {
        id: agent.id,
        companyId: agent.companyId,
        role: agent.role,
        name: agent.name,
        description: agent.description,
        enabled: agent.enabled,
        modelPolicy: agent.modelPolicy,
        permissions: JSON.stringify(agent.permissions),
      }
    });
  }

  console.log(`[seed] ✓ Demo company created: ${company.name} (${company.id})`);
  console.log(`[seed] ✓ Demo user: demo@trent.local`);
  console.log(`[seed] ✓ ${seedState.agents.length} agents seeded`);
  console.log("[seed] Done. Start the dev server with: npm run dev");
}

run().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
