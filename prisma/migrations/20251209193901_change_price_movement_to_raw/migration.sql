/*
  Warnings:

  - You are about to drop the column `price_movement_bps` on the `arena_assets` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "arena_assets" DROP COLUMN "price_movement_bps",
ADD COLUMN     "price_movement_raw" BIGINT;
