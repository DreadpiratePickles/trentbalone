import { describe, expect, it } from "vitest";
import { createDatabaseDesignPlan, createMigrationTestPlan } from "./database-designer";

describe("app builder database designer", () => {
  it("creates Prisma migration plans from entity descriptions", () => {
    const plan = createDatabaseDesignPlan({
      entities: [
        { name: "Customer", fields: ["email", "name"] },
        { name: "Booking", fields: ["startsAt", "status"] },
      ],
    });

    expect(plan.provider).toBe("prisma");
    expect(plan.models.map((model) => model.name)).toEqual(["Customer", "Booking"]);
    expect(plan.steps[0].title).toContain("Write schema tests");
    expect(plan.steps.some((step) => step.title.includes("Generate Prisma migration"))).toBe(true);
  });

  it("creates migration test commands before applying schema", () => {
    expect(createMigrationTestPlan("prisma")).toEqual([
      "npx prisma validate",
      "npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script",
      "npm test",
    ]);
  });
});
