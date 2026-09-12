import { describe, expect, it } from "vitest";
import { jobRunPatchToPrismaData } from "@/lib/prisma-store-workbench";

describe("jobRunPatchToPrismaData", () => {
  it("distinguishes omitted completion timestamps from explicit clears", () => {
    expect(jobRunPatchToPrismaData({ status: "running" })).not.toHaveProperty("completedAt");
    expect(jobRunPatchToPrismaData({ completedAt: undefined })).toMatchObject({ completedAt: null });

    const completedAt = "2026-06-06T02:00:00.000Z";
    expect(jobRunPatchToPrismaData({ completedAt }).completedAt).toEqual(new Date(completedAt));
  });
});
