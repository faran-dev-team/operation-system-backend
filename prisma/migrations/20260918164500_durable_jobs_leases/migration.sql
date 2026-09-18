-- AlterTable generation_jobs
ALTER TABLE "generation_jobs" ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP(3);
ALTER TABLE "generation_jobs" ADD COLUMN IF NOT EXISTS "lease_worker_id" TEXT;
ALTER TABLE "generation_jobs" ADD COLUMN IF NOT EXISTS "retry_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "generation_jobs" ADD COLUMN IF NOT EXISTS "max_retries" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "generation_jobs" ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP(3);
ALTER TABLE "generation_jobs" ADD COLUMN IF NOT EXISTS "operation_id" TEXT;
ALTER TABLE "generation_jobs" ADD COLUMN IF NOT EXISTS "dead_letter_reason" TEXT;
ALTER TABLE "generation_jobs" ADD COLUMN IF NOT EXISTS "dead_lettered_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "generation_jobs_status_lease_expires_at_next_retry_at_idx"
  ON "generation_jobs"("status", "lease_expires_at", "next_retry_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "generation_jobs_operation_id_idx"
  ON "generation_jobs"("operation_id");
