import { makeId } from "@/lib/utils";
import type { AppBuilderManifestStep } from "./types";

export type DatabaseEntitySpec = {
  name: string;
  fields: string[];
};

export function createDatabaseDesignPlan(input: { entities: DatabaseEntitySpec[] }) {
  const models = input.entities.map((entity) => ({
    name: toModelName(entity.name),
    fields: entity.fields.map((field) => field.trim()).filter(Boolean),
  }));
  return {
    id: makeId("dbdesign"),
    provider: "prisma" as const,
    models,
    testCommands: createMigrationTestPlan("prisma"),
    steps: [
      step("Write schema tests for generated models", false),
      step("Generate Prisma migration", false),
      step("Run migration validation and app tests", false),
    ],
  };
}

export function createMigrationTestPlan(provider: "prisma") {
  if (provider !== "prisma") throw new Error("Unsupported database provider");
  return [
    "npx prisma validate",
    "npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script",
    "npm test",
  ];
}

function step(title: string, requiresApproval: boolean): AppBuilderManifestStep {
  return {
    id: makeId("dbstep"),
    title,
    kind: "database",
    requiresApproval,
    riskClass: "reversible",
    estimatedCostCents: 100,
  };
}

function toModelName(value: string) {
  const clean = value.replace(/[^a-z0-9]+/gi, " ").trim();
  return clean
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
