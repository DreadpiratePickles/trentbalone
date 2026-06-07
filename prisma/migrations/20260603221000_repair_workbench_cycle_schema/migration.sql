ALTER TABLE "Cycle"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'scheduled';

ALTER TABLE "WorkbenchSession"
  ADD COLUMN IF NOT EXISTS "messageCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "WorkbenchChatMessage" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "agentMode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkbenchChatMessage_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'WorkbenchChatMessage_sessionId_fkey'
  ) THEN
    ALTER TABLE "WorkbenchChatMessage"
      ADD CONSTRAINT "WorkbenchChatMessage_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "WorkbenchChatMessage_sessionId_createdAt_idx"
  ON "WorkbenchChatMessage"("sessionId", "createdAt");

CREATE INDEX IF NOT EXISTS "WorkbenchChatMessage_companyId_createdAt_idx"
  ON "WorkbenchChatMessage"("companyId", "createdAt");
