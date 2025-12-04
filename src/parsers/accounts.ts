import { PublicKey } from '@solana/web3.js';
import {
  GlobalStateAccount,
  ArenaAccount,
  ArenaAssetAccount,
  PlayerEntryAccount,
  ArenaStatus,
} from '../types/accounts';

// Anchor discriminators from cryptarena_svm_test IDL
const DISCRIMINATORS = {
  GlobalState: Buffer.from([163, 46, 74, 168, 216, 123, 133, 98]),
  Arena: Buffer.from([243, 215, 44, 44, 231, 211, 232, 168]),
  ArenaAsset: Buffer.from([30, 253, 113, 69, 230, 167, 240, 40]),
  PlayerEntry: Buffer.from([158, 6, 39, 104, 234, 4, 153, 255]),
};

/**
 * Identify account type by discriminator
 */
export function identifyAccountType(data: Buffer): string | null {
  if (data.length < 8) return null;

  const discriminator = data.slice(0, 8);

  for (const [name, disc] of Object.entries(DISCRIMINATORS)) {
    if (discriminator.equals(disc)) {
      return name;
    }
  }

  return null;
}

/**
 * Parse GlobalState account
 */
export function parseGlobalState(data: Buffer): GlobalStateAccount {
  let offset = 8; // Skip discriminator

  const admin = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const treasuryWallet = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const arenaDuration = data.readBigInt64LE(offset);
  offset += 8;

  const currentArenaId = data.readBigUInt64LE(offset);
  offset += 8;

  const maxPlayersPerArena = data.readUInt8(offset);
  offset += 1;

  const maxSameAsset = data.readUInt8(offset);
  offset += 1;

  const isPaused = data.readUInt8(offset) === 1;
  offset += 1;

  const bump = data.readUInt8(offset);

  return {
    admin,
    treasuryWallet,
    arenaDuration,
    currentArenaId,
    maxPlayersPerArena,
    maxSameAsset,
    isPaused,
    bump,
  };
}

/**
 * Parse Arena account
 */
export function parseArena(data: Buffer): ArenaAccount {
  let offset = 8; // Skip discriminator

  const id = data.readBigUInt64LE(offset);
  offset += 8;

  const status = data.readUInt8(offset) as ArenaStatus;
  offset += 1;

  const playerCount = data.readUInt8(offset);
  offset += 1;

  const assetCount = data.readUInt8(offset);
  offset += 1;

  const pricesSet = data.readUInt8(offset);
  offset += 1;

  const endPricesSet = data.readUInt8(offset);
  offset += 1;

  const winningAsset = data.readUInt8(offset);
  offset += 1;

  const isSuspended = data.readUInt8(offset) === 1;
  offset += 1;

  const bump = data.readUInt8(offset);
  offset += 1;

  const startTimestamp = data.readBigInt64LE(offset);
  offset += 8;

  const endTimestamp = data.readBigInt64LE(offset);
  offset += 8;

  const totalPool = data.readBigUInt64LE(offset);

  return {
    id,
    status,
    playerCount,
    assetCount,
    pricesSet,
    endPricesSet,
    winningAsset,
    isSuspended,
    bump,
    startTimestamp,
    endTimestamp,
    totalPool,
  };
}

/**
 * Parse ArenaAsset account
 */
export function parseArenaAsset(data: Buffer): ArenaAssetAccount {
  let offset = 8; // Skip discriminator

  const arena = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const assetIndex = data.readUInt8(offset);
  offset += 1;

  const playerCount = data.readUInt8(offset);
  offset += 1;

  const startPrice = data.readBigUInt64LE(offset);
  offset += 8;

  const endPrice = data.readBigUInt64LE(offset);
  offset += 8;

  const priceMovement = data.readBigInt64LE(offset);
  offset += 8;

  const bump = data.readUInt8(offset);

  return {
    arena,
    assetIndex,
    playerCount,
    startPrice,
    endPrice,
    priceMovement,
    bump,
  };
}

/**
 * Parse PlayerEntry account
 */
export function parsePlayerEntry(data: Buffer): PlayerEntryAccount {
  let offset = 8; // Skip discriminator

  const arena = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const player = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const assetIndex = data.readUInt8(offset);
  offset += 1;

  const playerIndex = data.readUInt8(offset);
  offset += 1;

  const amount = data.readBigUInt64LE(offset);
  offset += 8;

  const usdValue = data.readBigUInt64LE(offset);
  offset += 8;

  const entryTimestamp = data.readBigInt64LE(offset);
  offset += 8;

  const isWinner = data.readUInt8(offset) === 1;
  offset += 1;

  const ownTokensClaimed = data.readUInt8(offset) === 1;
  offset += 1;

  // Read u128 as two u64s
  const rewardsClaimedBitmapLow = data.readBigUInt64LE(offset);
  offset += 8;
  const rewardsClaimedBitmapHigh = data.readBigUInt64LE(offset);
  offset += 8;
  const rewardsClaimedBitmap = rewardsClaimedBitmapLow + (rewardsClaimedBitmapHigh << 64n);

  const bump = data.readUInt8(offset);

  return {
    arena,
    player,
    assetIndex,
    playerIndex,
    amount,
    usdValue,
    entryTimestamp,
    isWinner,
    ownTokensClaimed,
    rewardsClaimedBitmap,
    bump,
  };
}

export default {
  identifyAccountType,
  parseGlobalState,
  parseArena,
  parseArenaAsset,
  parsePlayerEntry,
};

