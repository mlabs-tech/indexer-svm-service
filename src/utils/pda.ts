import { PublicKey } from '@solana/web3.js';
import config from '../config';

const PROGRAM_ID = new PublicKey(config.programId);

/**
 * Derive GlobalState PDA (cryptarena-sol)
 */
export function getGlobalStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_state')],
    PROGRAM_ID
  );
}

/**
 * Derive Arena PDA (cryptarena-sol)
 */
export function getArenaPda(arenaId: bigint): [PublicKey, number] {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(arenaId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('arena'), buffer],
    PROGRAM_ID
  );
}

/**
 * Derive ArenaVault PDA (cryptarena-sol)
 */
export function getArenaVaultPda(arenaId: bigint): [PublicKey, number] {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(arenaId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('arena_vault'), buffer],
    PROGRAM_ID
  );
}

/**
 * Derive PlayerEntry PDA (cryptarena-sol)
 */
export function getPlayerEntryPda(arenaPda: PublicKey, playerPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('player_entry'), arenaPda.toBuffer(), playerPubkey.toBuffer()],
    PROGRAM_ID
  );
}

/**
 * Derive WhitelistedToken PDA (cryptarena-sol)
 */
export function getWhitelistedTokenPda(assetIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('whitelist_token'), Buffer.from([assetIndex])],
    PROGRAM_ID
  );
}

export default {
  getGlobalStatePda,
  getArenaPda,
  getArenaVaultPda,
  getPlayerEntryPda,
  getWhitelistedTokenPda,
  PROGRAM_ID,
};
