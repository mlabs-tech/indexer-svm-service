import { PublicKey } from '@solana/web3.js';

/**
 * Arena Status enum matching on-chain values (cryptarena-sol)
 */
export enum ArenaStatus {
  Uninitialized = 0,
  Waiting = 1,
  Active = 2,
  Ended = 3,
  Canceled = 4,
}

export const ArenaStatusLabels: Record<ArenaStatus, string> = {
  [ArenaStatus.Uninitialized]: 'Uninitialized',
  [ArenaStatus.Waiting]: 'Waiting',
  [ArenaStatus.Active]: 'Active',
  [ArenaStatus.Ended]: 'Ended',
  [ArenaStatus.Canceled]: 'Canceled',
};

/**
 * GlobalState account structure (cryptarena-sol)
 */
export interface GlobalStateAccount {
  admin: PublicKey;
  treasuryWallet: PublicKey;
  arenaDuration: bigint;
  entryFee: bigint;
  currentArenaId: bigint;
  isPaused: boolean;
  bump: number;
}

/**
 * Arena account structure (cryptarena-sol)
 */
export interface ArenaAccount {
  id: bigint;
  status: ArenaStatus;
  playerCount: number;
  winningAsset: number;
  isCanceled: boolean;
  treasuryClaimed: boolean;
  bump: number;
  startTimestamp: bigint;
  endTimestamp: bigint;
  totalPool: bigint;
  tokenSlots: number[];
  playerAddresses: PublicKey[];
}

/**
 * PlayerEntry account structure (cryptarena-sol)
 * Now stores entry_fee (SOL) instead of token amount
 * Prices are stored directly on PlayerEntry instead of ArenaAsset
 */
export interface PlayerEntryAccount {
  arena: PublicKey;
  player: PublicKey;
  assetIndex: number;
  playerIndex: number;
  entryFee: bigint;        // SOL entry fee in lamports
  entryTimestamp: bigint;
  startPrice: bigint;      // Price at arena start (8 decimals)
  endPrice: bigint;        // Price at arena end (8 decimals)
  priceMovement: bigint;   // Price movement in basis points
  isWinner: boolean;
  hasClaimed: boolean;
  bump: number;
}

/**
 * WhitelistedToken account structure (cryptarena-sol)
 * Supports both Solana and EVM token addresses
 */
export interface WhitelistedTokenAccount {
  assetIndex: number;
  chainType: number;       // 0 = Solana, 1 = EVM
  isActive: boolean;
  bump: number;
  tokenAddress: Uint8Array; // 32 bytes
  symbol: string;          // Up to 10 chars
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
  { index: 5, symbol: 'PENGU', name: 'Pudgy Penguins' },
  { index: 6, symbol: 'PYTH', name: 'Pyth Network' },
  { index: 7, symbol: 'HNT', name: 'Helium' },
  { index: 8, symbol: 'FARTCOIN', name: 'Fartcoin' },
  { index: 9, symbol: 'RAY', name: 'Raydium' },
  { index: 10, symbol: 'JTO', name: 'Jito' },
  { index: 11, symbol: 'KMNO', name: 'Kamino Finance' },
  { index: 12, symbol: 'MET', name: 'Meteora' },
  { index: 13, symbol: 'W', name: 'Wormhole' },
  { index: 14, symbol: 'ETH', name: 'Ethereum' },
  { index: 15, symbol: 'UNI', name: 'Uniswap' },
  { index: 16, symbol: 'LINK', name: 'Chainlink' },
  { index: 17, symbol: 'PEPE', name: 'Pepe' },
  { index: 18, symbol: 'SHIB', name: 'Shiba Inu' },
] as const;

export function getAssetSymbol(index: number): string {
  return ASSETS.find(a => a.index === index)?.symbol || `UNKNOWN_${index}`;
}
