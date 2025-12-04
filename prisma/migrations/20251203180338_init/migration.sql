-- CreateTable
CREATE TABLE "protocol_state" (
    "id" SERIAL NOT NULL,
    "program_id" TEXT NOT NULL,
    "admin" TEXT NOT NULL,
    "treasury_wallet" TEXT NOT NULL,
    "arena_duration" INTEGER NOT NULL DEFAULT 60,
    "current_arena_id" BIGINT NOT NULL DEFAULT 0,
    "max_players_per_arena" INTEGER NOT NULL DEFAULT 10,
    "max_same_asset" INTEGER NOT NULL DEFAULT 3,
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocol_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" SERIAL NOT NULL,
    "index" INTEGER NOT NULL,
    "symbol" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "mint_address" VARCHAR(44),
    "decimals" INTEGER NOT NULL DEFAULT 9,
    "pyth_feed_id" VARCHAR(66),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arenas" (
    "id" BIGSERIAL NOT NULL,
    "arena_id" BIGINT NOT NULL,
    "pda" VARCHAR(44) NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 1,
    "player_count" INTEGER NOT NULL DEFAULT 0,
    "asset_count" INTEGER NOT NULL DEFAULT 0,
    "winning_asset" INTEGER,
    "is_suspended" BOOLEAN NOT NULL DEFAULT false,
    "start_timestamp" TIMESTAMP(3),
    "end_timestamp" TIMESTAMP(3),
    "total_pool_usd" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arenas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arena_assets" (
    "id" BIGSERIAL NOT NULL,
    "arena_id" BIGINT NOT NULL,
    "pda" VARCHAR(44) NOT NULL,
    "asset_index" INTEGER NOT NULL,
    "player_count" INTEGER NOT NULL DEFAULT 0,
    "start_price" DECIMAL(20,8),
    "end_price" DECIMAL(20,8),
    "price_movement_bps" INTEGER,
    "is_winner" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arena_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_entries" (
    "id" BIGSERIAL NOT NULL,
    "arena_id" BIGINT NOT NULL,
    "pda" VARCHAR(44) NOT NULL,
    "player_wallet" VARCHAR(44) NOT NULL,
    "player_index" INTEGER NOT NULL,
    "asset_index" INTEGER NOT NULL,
    "token_amount" DECIMAL(30,9) NOT NULL,
    "usd_value" DECIMAL(20,6) NOT NULL,
    "entry_timestamp" TIMESTAMP(3) NOT NULL,
    "is_winner" BOOLEAN NOT NULL DEFAULT false,
    "own_tokens_claimed" BOOLEAN NOT NULL DEFAULT false,
    "rewards_claimed_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" BIGSERIAL NOT NULL,
    "signature" VARCHAR(88) NOT NULL,
    "slot" BIGINT NOT NULL,
    "block_time" TIMESTAMP(3),
    "instruction_type" VARCHAR(50) NOT NULL,
    "program_id" VARCHAR(44) NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arena_events" (
    "id" BIGSERIAL NOT NULL,
    "arena_id" BIGINT NOT NULL,
    "event_type" VARCHAR(50) NOT NULL,
    "transaction_signature" VARCHAR(88),
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arena_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_actions" (
    "id" BIGSERIAL NOT NULL,
    "arena_id" BIGINT NOT NULL,
    "player_wallet" VARCHAR(44) NOT NULL,
    "action_type" VARCHAR(50) NOT NULL,
    "transaction_signature" VARCHAR(88),
    "asset_index" INTEGER,
    "token_amount" DECIMAL(30,9),
    "usd_value" DECIMAL(20,6),
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_claims" (
    "id" BIGSERIAL NOT NULL,
    "arena_id" BIGINT NOT NULL,
    "winner_wallet" VARCHAR(44) NOT NULL,
    "loser_wallet" VARCHAR(44),
    "transaction_signature" VARCHAR(88),
    "asset_index" INTEGER NOT NULL,
    "claim_type" VARCHAR(20) NOT NULL,
    "winner_amount" DECIMAL(30,9) NOT NULL,
    "treasury_amount" DECIMAL(30,9) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_stats" (
    "id" BIGSERIAL NOT NULL,
    "player_wallet" VARCHAR(44) NOT NULL,
    "total_arenas_played" INTEGER NOT NULL DEFAULT 0,
    "total_wins" INTEGER NOT NULL DEFAULT 0,
    "total_losses" INTEGER NOT NULL DEFAULT 0,
    "total_usd_wagered" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "total_usd_won" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "total_usd_lost" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "favorite_asset" INTEGER,
    "win_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "last_played_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_stats" (
    "id" SERIAL NOT NULL,
    "asset_index" INTEGER NOT NULL,
    "times_chosen" INTEGER NOT NULL DEFAULT 0,
    "times_won" INTEGER NOT NULL DEFAULT 0,
    "win_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "total_volume_usd" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "avg_price_movement_bps" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_stats" (
    "id" BIGSERIAL NOT NULL,
    "date" DATE NOT NULL,
    "total_arenas" INTEGER NOT NULL DEFAULT 0,
    "total_players" INTEGER NOT NULL DEFAULT 0,
    "unique_players" INTEGER NOT NULL DEFAULT 0,
    "total_volume_usd" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "total_treasury_fees" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_state" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "protocol_state_program_id_key" ON "protocol_state"("program_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_index_key" ON "assets"("index");

-- CreateIndex
CREATE UNIQUE INDEX "arenas_arena_id_key" ON "arenas"("arena_id");

-- CreateIndex
CREATE UNIQUE INDEX "arenas_pda_key" ON "arenas"("pda");

-- CreateIndex
CREATE INDEX "arenas_status_idx" ON "arenas"("status");

-- CreateIndex
CREATE INDEX "arenas_created_at_idx" ON "arenas"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "arena_assets_pda_key" ON "arena_assets"("pda");

-- CreateIndex
CREATE INDEX "arena_assets_arena_id_idx" ON "arena_assets"("arena_id");

-- CreateIndex
CREATE UNIQUE INDEX "arena_assets_arena_id_asset_index_key" ON "arena_assets"("arena_id", "asset_index");

-- CreateIndex
CREATE UNIQUE INDEX "player_entries_pda_key" ON "player_entries"("pda");

-- CreateIndex
CREATE INDEX "player_entries_arena_id_idx" ON "player_entries"("arena_id");

-- CreateIndex
CREATE INDEX "player_entries_player_wallet_idx" ON "player_entries"("player_wallet");

-- CreateIndex
CREATE INDEX "player_entries_is_winner_idx" ON "player_entries"("is_winner");

-- CreateIndex
CREATE UNIQUE INDEX "player_entries_arena_id_player_wallet_key" ON "player_entries"("arena_id", "player_wallet");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_signature_key" ON "transactions"("signature");

-- CreateIndex
CREATE INDEX "transactions_slot_idx" ON "transactions"("slot");

-- CreateIndex
CREATE INDEX "transactions_instruction_type_idx" ON "transactions"("instruction_type");

-- CreateIndex
CREATE INDEX "arena_events_arena_id_idx" ON "arena_events"("arena_id");

-- CreateIndex
CREATE INDEX "arena_events_event_type_idx" ON "arena_events"("event_type");

-- CreateIndex
CREATE INDEX "player_actions_player_wallet_idx" ON "player_actions"("player_wallet");

-- CreateIndex
CREATE INDEX "reward_claims_arena_id_idx" ON "reward_claims"("arena_id");

-- CreateIndex
CREATE INDEX "reward_claims_winner_wallet_idx" ON "reward_claims"("winner_wallet");

-- CreateIndex
CREATE UNIQUE INDEX "player_stats_player_wallet_key" ON "player_stats"("player_wallet");

-- CreateIndex
CREATE UNIQUE INDEX "asset_stats_asset_index_key" ON "asset_stats"("asset_index");

-- CreateIndex
CREATE UNIQUE INDEX "daily_stats_date_key" ON "daily_stats"("date");

-- CreateIndex
CREATE INDEX "daily_stats_date_idx" ON "daily_stats"("date");

-- CreateIndex
CREATE UNIQUE INDEX "sync_state_key_key" ON "sync_state"("key");

-- AddForeignKey
ALTER TABLE "arena_assets" ADD CONSTRAINT "arena_assets_arena_id_fkey" FOREIGN KEY ("arena_id") REFERENCES "arenas"("arena_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arena_assets" ADD CONSTRAINT "arena_assets_asset_index_fkey" FOREIGN KEY ("asset_index") REFERENCES "assets"("index") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_entries" ADD CONSTRAINT "player_entries_arena_id_fkey" FOREIGN KEY ("arena_id") REFERENCES "arenas"("arena_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_entries" ADD CONSTRAINT "player_entries_asset_index_fkey" FOREIGN KEY ("asset_index") REFERENCES "assets"("index") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arena_events" ADD CONSTRAINT "arena_events_arena_id_fkey" FOREIGN KEY ("arena_id") REFERENCES "arenas"("arena_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arena_events" ADD CONSTRAINT "arena_events_transaction_signature_fkey" FOREIGN KEY ("transaction_signature") REFERENCES "transactions"("signature") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_actions" ADD CONSTRAINT "player_actions_arena_id_fkey" FOREIGN KEY ("arena_id") REFERENCES "arenas"("arena_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_actions" ADD CONSTRAINT "player_actions_transaction_signature_fkey" FOREIGN KEY ("transaction_signature") REFERENCES "transactions"("signature") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_claims" ADD CONSTRAINT "reward_claims_arena_id_fkey" FOREIGN KEY ("arena_id") REFERENCES "arenas"("arena_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_claims" ADD CONSTRAINT "reward_claims_transaction_signature_fkey" FOREIGN KEY ("transaction_signature") REFERENCES "transactions"("signature") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_stats" ADD CONSTRAINT "asset_stats_asset_index_fkey" FOREIGN KEY ("asset_index") REFERENCES "assets"("index") ON DELETE RESTRICT ON UPDATE CASCADE;
