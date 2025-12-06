import { PublicKey } from '@solana/web3.js';
import config from '../config';

const PROGRAM_ID = new PublicKey(config.programId);

/**
 * Derive GlobalState PDA
 */
export function getGlobalStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_state_v2')],
    PROGRAM_ID
  );
}

/**
 * Derive Arena PDA
 */
export function getArenaPda(arenaId: bigint): [PublicKey, number] {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(arenaId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('arena_v2'), buffer],
    PROGRAM_ID
  );
}

/**
 * Derive ArenaAsset PDA
 */
export function getArenaAssetPda(arenaPda: PublicKey, assetIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('arena_asset_v2'), arenaPda.toBuffer(), Buffer.from([assetIndex])],
    PROGRAM_ID
  );
}

/**
 * Derive PlayerEntry PDA
 */
export function getPlayerEntryPda(arenaPda: PublicKey, playerPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('player_entry_v2'), arenaPda.toBuffer(), playerPubkey.toBuffer()],
    PROGRAM_ID
  );
}

/**
 * Derive WhitelistedToken PDA
 */
export function getWhitelistedTokenPda(mintPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('whitelist_token_v2'), mintPubkey.toBuffer()],
    PROGRAM_ID
  );
}

export default {
  getGlobalStatePda,
  getArenaPda,
  getArenaAssetPda,
  getPlayerEntryPda,
  getWhitelistedTokenPda,
  PROGRAM_ID,
};

