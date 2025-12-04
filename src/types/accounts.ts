import { PublicKey } from '@solana/web3.js';

/**
 * Arena Status enum matching on-chain values
 */
export enum ArenaStatus {
  Uninitialized = 0,
  Waiting = 1,
  Ready = 2,
  Active = 3,
  Ended = 4,
  Suspended = 5,
  Starting = 6,
  Ending = 7,
}

export const ArenaStatusLabels: Record<ArenaStatus, string> = {
  [ArenaStatus.Uninitialized]: 'Uninitialized',
  [ArenaStatus.Waiting]: 'Waiting',
  [ArenaStatus.Ready]: 'Ready',
  [ArenaStatus.Active]: 'Active',
  [ArenaStatus.Ended]: 'Ended',
  [ArenaStatus.Suspended]: 'Suspended',
  [ArenaStatus.Starting]: 'Starting',
  [ArenaStatus.Ending]: 'Ending',
};

/**
 * GlobalState account structure
 */
export interface GlobalStateAccount {
  admin: PublicKey;
  treasuryWallet: PublicKey;
  arenaDuration: bigint;
  currentArenaId: bigint;
  maxPlayersPerArena: number;
  maxSameAsset: number;
  isPaused: boolean;
  bump: number;
}

/**
 * Arena account structure
 */
export interface ArenaAccount {
  id: bigint;
  status: ArenaStatus;
  playerCount: number;
  assetCount: number;
  pricesSet: number;
  endPricesSet: number;
  winningAsset: number;
  isSuspended: boolean;
  bump: number;
  startTimestamp: bigint;
  endTimestamp: bigint;
  totalPool: bigint;
}

/**
 * ArenaAsset account structure
 */
export interface ArenaAssetAccount {
  arena: PublicKey;
  assetIndex: number;
  playerCount: number;
  startPrice: bigint;
  endPrice: bigint;
  priceMovement: bigint;
  bump: number;
}

/**
 * PlayerEntry account structure
 */
export interface PlayerEntryAccount {
  arena: PublicKey;
  player: PublicKey;
  assetIndex: number;
  playerIndex: number;
  amount: bigint;
  usdValue: bigint;
  entryTimestamp: bigint;
  isWinner: boolean;
  ownTokensClaimed: boolean;
  rewardsClaimedBitmap: bigint;
  bump: number;
}

/**
 * Supported assets
 */
export const ASSETS = [
  { index: 0, symbol: 'SOL', name: 'Solana' },
  { index: 1, symbol: 'TRUMP', name: 'Official Trump' },
  { index: 2, symbol: 'PUMP', name: 'Pump.fun' },
  { index: 3, symbol: 'BONK', name: 'Bonk' },
  { index: 4, symbol: 'JUP', name: 'Jupiter' },
  { index: 5, symbol: 'PENGU', name: 'Pudgy Penguin' },
  { index: 6, symbol: 'PYTH', name: 'Pyth Network' },
  { index: 7, symbol: 'HNT', name: 'Helium' },
  { index: 8, symbol: 'FARTCOIN', name: 'Fartcoin' },
  { index: 9, symbol: 'RAY', name: 'Raydium' },
  { index: 10, symbol: 'JTO', name: 'Jito' },
  { index: 11, symbol: 'KMNO', name: 'Kamino' },
  { index: 12, symbol: 'MET', name: 'Meteora' },
  { index: 13, symbol: 'W', name: 'Wormhole' },
] as const;

export function getAssetSymbol(index: number): string {
  return ASSETS[index]?.symbol || `UNKNOWN_${index}`;
}

