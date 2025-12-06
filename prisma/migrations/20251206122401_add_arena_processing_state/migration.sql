-- CreateTable
CREATE TABLE "arena_processing_state" (
    "id" BIGSERIAL NOT NULL,
    "arena_id" BIGINT NOT NULL,
    "start_status" TEXT NOT NULL DEFAULT 'pending',
    "end_status" TEXT NOT NULL DEFAULT 'pending',
    "start_job_id" TEXT,
    "end_job_id" TEXT,
    "start_error" TEXT,
    "end_error" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "scheduled_end_time" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arena_processing_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "arena_processing_state_arena_id_key" ON "arena_processing_state"("arena_id");
