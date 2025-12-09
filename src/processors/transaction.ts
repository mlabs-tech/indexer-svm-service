import { ParsedTransactionWithMeta, PublicKey, PartiallyDecodedInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  identifyInstruction,
  parseEnterArenaData,
  parseSetPriceData,
  extractAccountsFromInstruction,
  InstructionType,
} from '../parsers/instructions';
import { getAssetSymbol } from '../types/accounts';
import prisma from '../db';
import config from '../config';
import logger from '../utils/logger';
import { processAccountUpdate } from './index';
import { getAccountInfo } from '../solana/connection';

const PROGRAM_ID = new PublicKey(config.programId);

/**
 * Process a parsed transaction
 */
export async function processTransaction(
  tx: ParsedTransactionWithMeta,
  signature: string,
  slot: number
): Promise<void> {
  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;

  // Find instructions for our program
  const instructions = tx.transaction.message.instructions.filter((ix) => {
    if ('programId' in ix) {
      return ix.programId.equals(PROGRAM_ID);
    }
    return false;
  }) as PartiallyDecodedInstruction[];

  if (instructions.length === 0) {
    return;
  }

  for (const ix of instructions) {
    try {
      await processInstruction(ix, signature, slot, blockTime, tx);
    } catch (error) {
      logger.error({ error, signature }, 'Error processing instruction');
    }
  }
}

/**
 * Process a single instruction
 */
async function processInstruction(
  ix: PartiallyDecodedInstruction,
  signature: string,
  slot: number,
  blockTime: Date | null,
  tx: ParsedTransactionWithMeta
): Promise<void> {
  // Decode instruction data (Solana uses base58)
  const data = Buffer.from(bs58.decode(ix.data));
  const instructionType = identifyInstruction(data);

  if (!instructionType) {
    logger.debug({ signature }, 'Unknown instruction type');
    return;
  }

  // Get account keys
  const accountKeys = ix.accounts.map((a) => a.toString());

  // Extract relevant accounts
  const accounts = extractAccountsFromInstruction(instructionType, accountKeys);

  logger.debug({ instructionType, signature: signature.slice(0, 16), slot }, 'Processing instruction');

  // Store transaction record
  await prisma.transaction.upsert({
    where: { signature },
    update: {},
    create: {
      signature,
      slot: BigInt(slot),
      blockTime,
      instructionType,
      programId: PROGRAM_ID.toString(),
      success: true,
    },
  });

  // First, refresh account data from chain to ensure records exist in DB
  await refreshAccountsFromChain(accounts);

  // Process based on instruction type
  switch (instructionType) {
    case 'enterArena':
      await handleEnterArena(data, accounts, signature, blockTime);
      break;

    case 'setStartPrice':
      await handleSetStartPrice(data, accounts, signature, blockTime);
      break;

    case 'setEndPrice':
      await handleSetEndPrice(data, accounts, signature, blockTime);
      break;

    case 'finalizeArena':
      await handleFinalizeArena(accounts, signature, blockTime);
      break;

    case 'claimOwnTokens':
      await handleClaimOwnTokens(accounts, signature, blockTime);
      break;

    case 'claimLoserTokens':
      await handleClaimLoserTokens(accounts, signature, blockTime);
      break;

    default:
      logger.debug({ instructionType }, 'Unhandled instruction type');
  }
}

/**
 * Handle enterArena instruction
 */
async function handleEnterArena(
  data: Buffer,
  accounts: ReturnType<typeof extractAccountsFromInstruction>,
  signature: string,
  blockTime: Date | null
): Promise<void> {
  const parsed = parseEnterArenaData(data);
  if (!parsed || !accounts.arena || !accounts.player) return;

  // Find arena ID from database
  const arena = await prisma.arena.findFirst({
    where: { pda: accounts.arena },
  });

  if (!arena) {
    logger.warn({ arenaPda: accounts.arena }, 'Arena not found for enterArena');
    return;
  }

  const tokenAmount = Number(parsed.amount) / 1e9;
  const usdValue = Number(parsed.usdValue) / 1e6;

  // Create player action event
  await prisma.playerAction.create({
    data: {
      arenaId: arena.arenaId,
      playerWallet: accounts.player,
      actionType: 'enter_arena',
      transactionSignature: signature,
      assetIndex: parsed.assetIndex,
      tokenAmount,
      usdValue,
      data: {
        assetSymbol: getAssetSymbol(parsed.assetIndex),
      },
    },
  });

  // Create arena event
  await prisma.arenaEvent.create({
    data: {
      arenaId: arena.arenaId,
      eventType: 'player_joined',
      transactionSignature: signature,
      data: {
        player: accounts.player,
        assetIndex: parsed.assetIndex,
        assetSymbol: getAssetSymbol(parsed.assetIndex),
        tokenAmount,
        usdValue,
      },
    },
  });

  logger.info({
    arenaId: arena.arenaId.toString(),
    player: accounts.player.slice(0, 8),
    asset: getAssetSymbol(parsed.assetIndex),
    usdValue,
  }, 'Player entered arena');
}

/**
 * Handle setStartPrice instruction
 */
async function handleSetStartPrice(
  data: Buffer,
  accounts: ReturnType<typeof extractAccountsFromInstruction>,
  signature: string,
  blockTime: Date | null
): Promise<void> {
  const parsed = parseSetPriceData(data);
  if (!parsed || !accounts.arena || !accounts.arenaAsset) return;

  const arena = await prisma.arena.findFirst({
    where: { pda: accounts.arena },
  });

  if (!arena) return;

  const price = Number(parsed.price) / 1e12;

  // Get asset index from arenaAsset
  const arenaAsset = await prisma.arenaAsset.findFirst({
    where: { pda: accounts.arenaAsset },
  });

  const assetIndex = arenaAsset?.assetIndex || 0;

  await prisma.arenaEvent.create({
    data: {
      arenaId: arena.arenaId,
      eventType: 'start_price_set',
      transactionSignature: signature,
      data: {
        assetIndex,
        assetSymbol: getAssetSymbol(assetIndex),
        price,
      },
    },
  });

  logger.debug({
    arenaId: arena.arenaId.toString(),
    asset: getAssetSymbol(assetIndex),
    price,
  }, 'Start price set');
}

/**
 * Handle setEndPrice instruction
 */
async function handleSetEndPrice(
  data: Buffer,
  accounts: ReturnType<typeof extractAccountsFromInstruction>,
  signature: string,
  blockTime: Date | null
): Promise<void> {
  const parsed = parseSetPriceData(data);
  if (!parsed || !accounts.arena || !accounts.arenaAsset) return;

  const arena = await prisma.arena.findFirst({
    where: { pda: accounts.arena },
  });

  if (!arena) return;

  const price = Number(parsed.price) / 1e12;

  const arenaAsset = await prisma.arenaAsset.findFirst({
    where: { pda: accounts.arenaAsset },
  });

  const assetIndex = arenaAsset?.assetIndex || 0;

  await prisma.arenaEvent.create({
    data: {
      arenaId: arena.arenaId,
      eventType: 'end_price_set',
      transactionSignature: signature,
      data: {
        assetIndex,
        assetSymbol: getAssetSymbol(assetIndex),
        price,
      },
    },
  });

  logger.debug({
    arenaId: arena.arenaId.toString(),
    asset: getAssetSymbol(assetIndex),
    price,
  }, 'End price set');
}

/**
 * Handle finalizeArena instruction
 */
async function handleFinalizeArena(
  accounts: ReturnType<typeof extractAccountsFromInstruction>,
  signature: string,
  blockTime: Date | null
): Promise<void> {
  if (!accounts.arena) return;

  const arena = await prisma.arena.findFirst({
    where: { pda: accounts.arena },
  });

  if (!arena) return;

  await prisma.arenaEvent.create({
    data: {
      arenaId: arena.arenaId,
      eventType: 'arena_finalized',
      transactionSignature: signature,
      data: {},
    },
  });

  logger.info({ arenaId: arena.arenaId.toString() }, 'Arena finalized');
}

/**
 * Handle claimOwnTokens instruction
 */
async function handleClaimOwnTokens(
  accounts: ReturnType<typeof extractAccountsFromInstruction>,
  signature: string,
  blockTime: Date | null
): Promise<void> {
  if (!accounts.arena || !accounts.winner || !accounts.playerEntry) return;

  const arena = await prisma.arena.findFirst({
    where: { pda: accounts.arena },
  });

  if (!arena) return;

  const playerEntry = await prisma.playerEntry.findFirst({
    where: { pda: accounts.playerEntry },
  });

  if (!playerEntry) return;

  // Create reward claim record
  await prisma.rewardClaim.create({
    data: {
      arenaId: arena.arenaId,
      winnerWallet: accounts.winner,
      transactionSignature: signature,
      assetIndex: playerEntry.assetIndex,
      claimType: 'own_tokens',
      winnerAmount: playerEntry.tokenAmount,
      treasuryAmount: 0,
    },
  });

  await prisma.playerAction.create({
    data: {
      arenaId: arena.arenaId,
      playerWallet: accounts.winner,
      actionType: 'claim_own_tokens',
      transactionSignature: signature,
      assetIndex: playerEntry.assetIndex,
      tokenAmount: playerEntry.tokenAmount,
    },
  });

  logger.info({
    arenaId: arena.arenaId.toString(),
    winner: accounts.winner.slice(0, 8),
    asset: getAssetSymbol(playerEntry.assetIndex),
  }, 'Own tokens claimed');
}

/**
 * Handle claimLoserTokens instruction
 */
async function handleClaimLoserTokens(
  accounts: ReturnType<typeof extractAccountsFromInstruction>,
  signature: string,
  blockTime: Date | null
): Promise<void> {
  if (!accounts.arena || !accounts.winner || !accounts.loserEntry) return;

  const arena = await prisma.arena.findFirst({
    where: { pda: accounts.arena },
  });

  if (!arena) return;

  const loserEntry = await prisma.playerEntry.findFirst({
    where: { pda: accounts.loserEntry },
  });

  if (!loserEntry) return;

  // Calculate amounts (90% winner, 10% treasury)
  const totalAmount = Number(loserEntry.tokenAmount);
  const winnerAmount = totalAmount * 0.9;
  const treasuryAmount = totalAmount * 0.1;

  // Find winner count to determine per-winner share
  const winnerAssetCount = await prisma.arenaAsset.findFirst({
    where: { arenaId: arena.arenaId, isWinner: true },
  });

  const winnerCount = winnerAssetCount?.playerCount || 1;
  const perWinnerAmount = winnerAmount / winnerCount;
  const perWinnerTreasury = treasuryAmount / winnerCount;

  await prisma.rewardClaim.create({
    data: {
      arenaId: arena.arenaId,
      winnerWallet: accounts.winner,
      loserWallet: loserEntry.playerWallet,
      transactionSignature: signature,
      assetIndex: loserEntry.assetIndex,
      claimType: 'loser_tokens',
      winnerAmount: perWinnerAmount,
      treasuryAmount: perWinnerTreasury,
    },
  });

  await prisma.playerAction.create({
    data: {
      arenaId: arena.arenaId,
      playerWallet: accounts.winner,
      actionType: 'claim_loser_tokens',
      transactionSignature: signature,
      assetIndex: loserEntry.assetIndex,
      tokenAmount: perWinnerAmount,
      data: {
        loserWallet: loserEntry.playerWallet,
        treasuryFee: perWinnerTreasury,
      },
    },
  });

  logger.info({
    arenaId: arena.arenaId.toString(),
    winner: accounts.winner.slice(0, 8),
    loser: loserEntry.playerWallet.slice(0, 8),
    asset: getAssetSymbol(loserEntry.assetIndex),
    amount: perWinnerAmount,
  }, 'Loser tokens claimed');
}

/**
 * Refresh account data from chain after transaction
 */
async function refreshAccountsFromChain(
  accounts: ReturnType<typeof extractAccountsFromInstruction>
): Promise<void> {
  const { identifyAccountType } = await import('../parsers/accounts');

  const accountsToRefresh = [
    accounts.globalState,
    accounts.arena,
    accounts.arenaAsset,
    accounts.playerEntry,
    accounts.loserEntry,
  ].filter(Boolean) as string[];

  for (const pubkeyStr of accountsToRefresh) {
    try {
      const pubkey = new PublicKey(pubkeyStr);
      const accountInfo = await getAccountInfo(pubkey);

      if (accountInfo?.data) {
        const accountType = identifyAccountType(accountInfo.data);
        if (accountType) {
          await processAccountUpdate(pubkey, accountInfo.data, accountType, 0);
        }
      }
    } catch (error) {
      logger.error({ error, pubkey: pubkeyStr }, 'Error refreshing account');
    }
  }
}

export default { processTransaction };

