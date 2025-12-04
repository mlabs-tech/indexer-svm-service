-- AlterTable
ALTER TABLE "player_entries" ADD COLUMN     "rewards_claimed_bitmap" VARCHAR(40) NOT NULL DEFAULT '0';
