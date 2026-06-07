ALTER TABLE "WorkbenchEvent" ADD COLUMN IF NOT EXISTS "seq" INTEGER;

WITH ordered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "sessionId" ORDER BY "createdAt", "id") AS rn
  FROM "WorkbenchEvent"
)
UPDATE "WorkbenchEvent" AS event
SET "seq" = ordered.rn
FROM ordered
WHERE event."id" = ordered."id" AND event."seq" IS NULL;

ALTER TABLE "WorkbenchEvent" ALTER COLUMN "seq" SET DEFAULT 0;
ALTER TABLE "WorkbenchEvent" ALTER COLUMN "seq" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "WorkbenchEvent_sessionId_seq_key"
  ON "WorkbenchEvent"("sessionId", "seq");
