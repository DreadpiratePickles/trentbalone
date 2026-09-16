-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "cycleId" TEXT,
ADD COLUMN     "goalId" TEXT;

-- AlterTable
ALTER TABLE "Cycle" ADD COLUMN     "goalId" TEXT;

-- CreateTable
CREATE TABLE "_TaskBlocks" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_TaskBlocks_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_TaskBlocks_B_index" ON "_TaskBlocks"("B");

-- CreateIndex
CREATE INDEX "Task_goalId_idx" ON "Task"("goalId");

-- CreateIndex
CREATE INDEX "Task_cycleId_idx" ON "Task"("cycleId");

-- CreateIndex
CREATE INDEX "Cycle_goalId_idx" ON "Cycle"("goalId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TaskBlocks" ADD CONSTRAINT "_TaskBlocks_A_fkey" FOREIGN KEY ("A") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TaskBlocks" ADD CONSTRAINT "_TaskBlocks_B_fkey" FOREIGN KEY ("B") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

