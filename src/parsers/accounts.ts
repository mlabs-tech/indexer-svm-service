import { PublicKey } from '@solana/web3.js';
import {
  GlobalStateAccount,
  ArenaAccount,
  PlayerEntryAccount,
  WhitelistedTokenAccount,
  ArenaStatus,
} from '../types/accounts';

// Anchor discriminators from cryptarena_sol IDL
const DISCRIMINATORS = {
  GlobalState: Buffer.from([163, 46, 74, 168, 216, 123, 133, 98]),
  Arena: Buffer.from([243, 215, 44, 44, 231, 211, 232, 168]),
  ArenaVault: Buffer.from([110, 174, 28, 139, 111, 244, 28, 184]), // Just holds SOL, no data to parse
  PlayerEntry: Buffer.from([158, 6, 39, 104, 234, 4, 153, 255]),
  WhitelistedToken: Buffer.from([217, 124, 32, 114, 40, 167, 143, 233]),
};

// Account types to skip processing (they're identified but not processed)
export const SKIP_ACCOUNT_TYPES = ['ArenaVault'];

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
 * Parse GlobalState account (cryptarena-sol)
 * Layout: admin(32) + treasury_wallet(32) + arena_duration(8) + entry_fee(8) + 
 *         current_arena_id(8) + is_paused(1) + bump(1)
 */
export function parseGlobalState(data: Buffer): GlobalStateAccount {
  let offset = 8; // Skip discriminator

  const admin = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const treasuryWallet = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const arenaDuration = data.readBigInt64LE(offset);
  offset += 8;

  const entryFee = data.readBigUInt64LE(offset);
  offset += 8;

  const currentArenaId = data.readBigUInt64LE(offset);
  offset += 8;

  const isPaused = data.readUInt8(offset) === 1;
  offset += 1;

  const bump = data.readUInt8(offset);

  return {
    admin,
    treasuryWallet,
    arenaDuration,
    entryFee,
    currentArenaId,
    isPaused,
    bump,
  };
}

/**
 * Parse Arena account (cryptarena-sol)
 * Layout: id(8) + status(1) + player_count(1) + winning_asset(1) + is_canceled(1) + 
 *         treasury_claimed(1) + bump(1) + start_timestamp(8) + end_timestamp(8) + 
 *         total_pool(8) + token_slots(10) + player_addresses(32*10)
 */
export function parseArena(data: Buffer): ArenaAccount {
  let offset = 8; // Skip discriminator

  const id = data.readBigUInt64LE(offset);
  offset += 8;

  const status = data.readUInt8(offset) as ArenaStatus;
  offset += 1;

  const playerCount = data.readUInt8(offset);
  offset += 1;

  const winningAsset = data.readUInt8(offset);
  offset += 1;

  const isCanceled = data.readUInt8(offset) === 1;
  offset += 1;

  const treasuryClaimed = data.readUInt8(offset) === 1;
  offset += 1;

  const bump = data.readUInt8(offset);
  offset += 1;

  const startTimestamp = data.readBigInt64LE(offset);
  offset += 8;

  const endTimestamp = data.readBigInt64LE(offset);
  offset += 8;

  const totalPool = data.readBigUInt64LE(offset);
  offset += 8;

  // Read token_slots (10 bytes)
  const tokenSlots: number[] = [];
  for (let i = 0; i < 10; i++) {
    tokenSlots.push(data.readUInt8(offset + i));
  }
  offset += 10;

  // Read player_addresses (10 x 32 bytes)
  const playerAddresses: PublicKey[] = [];
  for (let i = 0; i < 10; i++) {
    playerAddresses.push(new PublicKey(data.slice(offset, offset + 32)));
    offset += 32;
  }

  return {
    id,
    status,
    playerCount,
    winningAsset,
    isCanceled,
    treasuryClaimed,
    bump,
    startTimestamp,
    endTimestamp,
    totalPool,
    tokenSlots,
    playerAddresses,
  };
}

/**
 * Parse PlayerEntry account (cryptarena-sol)
 * Layout: arena(32) + player(32) + asset_index(1) + player_index(1) + entry_fee(8) + 
 *         entry_timestamp(8) + start_price(8) + end_price(8) + price_movement(8) + 
 *         is_winner(1) + has_claimed(1) + bump(1)
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

  const entryFee = data.readBigUInt64LE(offset);
  offset += 8;

  const entryTimestamp = data.readBigInt64LE(offset);
  offset += 8;

  const startPrice = data.readBigUInt64LE(offset);
  offset += 8;

  const endPrice = data.readBigUInt64LE(offset);
  offset += 8;

  const priceMovement = data.readBigInt64LE(offset);
  offset += 8;

  const isWinner = data.readUInt8(offset) === 1;
  offset += 1;

  const hasClaimed = data.readUInt8(offset) === 1;
  offset += 1;

  const bump = data.readUInt8(offset);

  return {
    arena,
    player,
    assetIndex,
    playerIndex,
    entryFee,
    entryTimestamp,
    startPrice,
    endPrice,
    priceMovement,
    isWinner,
    hasClaimed,
    bump,
  };
}

/**
 * Parse WhitelistedToken account (cryptarena-sol)
 * Layout: asset_index(1) + chain_type(1) + is_active(1) + bump(1) + token_address(32) + symbol(10)
 */
export function parseWhitelistedToken(data: Buffer): WhitelistedTokenAccount {
  let offset = 8; // Skip discriminator

  const assetIndex = data.readUInt8(offset);
  offset += 1;

  const chainType = data.readUInt8(offset);
  offset += 1;

  const isActive = data.readUInt8(offset) === 1;
  offset += 1;

  const bump = data.readUInt8(offset);
  offset += 1;

  const tokenAddress = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  // Read symbol (10 bytes), trim null characters
  const symbolBytes = data.slice(offset, offset + 10);
  const symbol = symbolBytes.toString('utf8').replace(/\0/g, '').trim();

  return {
    assetIndex,
    chainType,
    isActive,
    bump,
    tokenAddress,
    symbol,
  };
}

export default {
  identifyAccountType,
  parseGlobalState,
  parseArena,
  parsePlayerEntry,
  parseWhitelistedToken,
};
