import { FastifyInstance } from 'fastify';
import prisma from '../../db';
import { ArenaStatusLabels, ArenaStatus, getAssetSymbol } from '../../types/accounts';
import { calculateRealTimePoolValue, calculateRealTimePoolValueBatch } from '../../utils/poolCalculator';
import { cacheService } from '../../services/cacheService';
import lifecycleConfig from '../../services/arenaLifecycle/config';

export async function registerArenaRoutes(app: FastifyInstance): Promise<void> {
  // List arenas with pagination
  app.get('/api/v1/arenas', async (request) => {
    const { page = '1', limit = '20', status } = request.query as {
      page?: string;
      limit?: string;
      status?: string;
    };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = status ? { status: parseInt(status) } : {};

    const [arenas, total] = await Promise.all([
      prisma.arena.findMany({
        where,
        orderBy: { arenaId: 'desc' },
        skip,
        take,
        include: {
          arenaAssets: {
            select: {
              assetIndex: true,
              playerCount: true,
              isWinner: true,
            },
          },
          _count: {
            select: { playerEntries: true },
          },
        },
      }),
      prisma.arena.count({ where }),
    ]);

    // Calculate real-time pool values for all arenas in batch
    const arenaIds = arenas.map(a => a.arenaId);
    const poolValues = await calculateRealTimePoolValueBatch(arenaIds);

    return {
      data: arenas.map((arena) => {
        const poolValue = poolValues.get(arena.arenaId.toString()) || { totalPoolSol: 0, totalPoolUsd: 0 };
        return {
          id: arena.id.toString(),
          arenaId: arena.arenaId.toString(),
          pda: arena.pda,
          status: arena.status,
          statusLabel: ArenaStatusLabels[arena.status as ArenaStatus],
          playerCount: arena.playerCount,
          assetCount: arena.assetCount,
          winningAsset: arena.winningAsset,
          winningAssetSymbol: arena.winningAsset !== null ? getAssetSymbol(arena.winningAsset) : null,
          isSuspended: arena.isSuspended,
          startTimestamp: arena.startTimestamp?.toISOString() || null,
          endTimestamp: arena.endTimestamp?.toISOString() || null,
          totalPoolSol: poolValue.totalPoolSol,
          totalPoolUsd: poolValue.totalPoolUsd,
          createdAt: arena.createdAt.toISOString(),
          arenaAssets: arena.arenaAssets.map((asset) => ({
            assetIndex: asset.assetIndex,
            assetSymbol: getAssetSymbol(asset.assetIndex),
            playerCount: asset.playerCount,
            isWinner: asset.isWinner,
          })),
        };
      }),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / take),
      },
    };
  });

  // Get active/waiting arenas
  app.get('/api/v1/arenas/active', async () => {
    const arenas = await prisma.arena.findMany({
      where: {
        status: {
          in: [ArenaStatus.Waiting, ArenaStatus.Active],
        },
      },
      orderBy: { arenaId: 'desc' },
      include: {
        arenaAssets: true,
        playerEntries: {
          select: {
            playerWallet: true,
            assetIndex: true,
            usdValue: true,
          },
        },
      },
    });

    return arenas.map((arena) => ({
      ...arena,
      arenaId: arena.arenaId.toString(),
      statusLabel: ArenaStatusLabels[arena.status as ArenaStatus],
    }));
  });

  // Get current arena (the one accepting new players - Waiting status) - with caching
  // If no waiting arena exists, returns null (frontend should show "Be the first!")
  app.get('/api/v1/arenas/current', async () => {
    const cacheKey = 'arenas:current';

    // Try to get from cache first
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    // Find the arena that is currently accepting players (Waiting status)
    const currentArena = await prisma.arena.findFirst({
      where: {
        status: ArenaStatus.Waiting,
      },
      orderBy: { arenaId: 'desc' },
      include: {
        arenaAssets: {
          select: {
            assetIndex: true,
            playerCount: true,
          },
        },
        playerEntries: {
          select: {
            playerWallet: true,
            playerIndex: true,
            assetIndex: true,
            tokenAmount: true,
            usdValue: true,
            entryPrice: true,
            actualUsdValue: true,
            entryTimestamp: true,
          },
          orderBy: { playerIndex: 'asc' },
        },
      },
    });

    let response;

    if (!currentArena) {
      // No arena currently accepting players - next player will start a new one
      // Get the protocol state to know what the next arena ID would be
      const protocolState = await prisma.protocolState.findFirst();
      
      response = {
        exists: false,
        nextArenaId: protocolState ? (Number(protocolState.currentArenaId) + 1).toString() : '1',
        message: 'No arena currently accepting players. Be the first to start a new arena!',
      };
    } else {
      // Calculate real-time total pool value using latest market prices
      const poolValue = await calculateRealTimePoolValue(currentArena.arenaId);

      // Calculate countdown info (10 minutes from arena creation)
      const countdownStartAt = currentArena.createdAt;
      const countdownEndsAt = new Date(countdownStartAt.getTime() + lifecycleConfig.waitingCountdownMs);
      const countdownRemainingMs = Math.max(0, countdownEndsAt.getTime() - Date.now());

      // Serialize BigInt fields to strings for JSON response
      response = {
        exists: true,
        arena: {
          id: currentArena.id.toString(),
          arenaId: currentArena.arenaId.toString(),
          pda: currentArena.pda,
          status: currentArena.status,
          statusLabel: ArenaStatusLabels[currentArena.status as ArenaStatus],
          playerCount: currentArena.playerCount,
          assetCount: currentArena.assetCount,
          totalPoolSol: poolValue.totalPoolSol,
          totalPoolUsd: poolValue.totalPoolUsd,
          startTimestamp: currentArena.startTimestamp?.toISOString() || null,
          endTimestamp: currentArena.endTimestamp?.toISOString() || null,
          winningAsset: currentArena.winningAsset,
          maxPlayers: 10, // From program config
          // Countdown info for waiting room
          countdownStartAt: countdownStartAt.toISOString(),
          countdownEndsAt: countdownEndsAt.toISOString(),
          countdownRemainingMs,
          countdownDurationMs: lifecycleConfig.waitingCountdownMs,
          playerEntries: currentArena.playerEntries.map((entry) => ({
            playerWallet: entry.playerWallet,
            playerIndex: entry.playerIndex,
            assetIndex: entry.assetIndex,
            assetSymbol: getAssetSymbol(entry.assetIndex),
            tokenAmount: entry.tokenAmount ? Number(entry.tokenAmount) : 0,
            usdValue: entry.usdValue ? Number(entry.usdValue) : 0,
            entryPrice: entry.entryPrice ? Number(entry.entryPrice) : undefined,
            actualUsdValue: entry.actualUsdValue ? Number(entry.actualUsdValue) : undefined,
            entryTimestamp: entry.entryTimestamp?.toISOString() || null,
          })),
          arenaAssets: currentArena.arenaAssets.map((asset) => ({
            assetIndex: asset.assetIndex,
            assetSymbol: getAssetSymbol(asset.assetIndex),
            playerCount: asset.playerCount,
          })),
        },
      };
    }

    // Cache for 2 seconds (frequently changing as players join)
    await cacheService.set(cacheKey, response, 2);
    
    return response;
  });

  // Check if a specific wallet is already in the current waiting arena
  app.get('/api/v1/arenas/current/check-player/:wallet', async (request) => {
    const { wallet } = request.params as { wallet: string };

    // Find current waiting arena
    const currentArena = await prisma.arena.findFirst({
      where: {
        status: ArenaStatus.Waiting,
      },
      orderBy: { arenaId: 'desc' },
    });

    if (!currentArena) {
      return {
        hasCurrentArena: false,
        isInArena: false,
        message: 'No arena currently accepting players',
      };
    }

    // Check if player is in this arena
    const playerEntry = await prisma.playerEntry.findFirst({
      where: {
        arenaId: currentArena.arenaId,
        playerWallet: wallet,
      },
    });

    return {
      hasCurrentArena: true,
      arenaId: currentArena.arenaId.toString(),
      arenaStatus: ArenaStatusLabels[currentArena.status as ArenaStatus],
      isInArena: !!playerEntry,
      playerEntry: playerEntry ? {
        assetIndex: playerEntry.assetIndex,
        assetSymbol: getAssetSymbol(playerEntry.assetIndex),
        tokenAmount: playerEntry.tokenAmount ? Number(playerEntry.tokenAmount) : 0,
        usdValue: playerEntry.usdValue ? Number(playerEntry.usdValue) : 0,
        playerIndex: playerEntry.playerIndex,
      } : null,
    };
  });

  // Get arena by ID (with caching)
  app.get('/api/v1/arenas/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const cacheKey = `arena:${id}`;

    // Try to get from cache first
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const arena = await prisma.arena.findUnique({
      where: { arenaId: BigInt(id) },
      include: {
        arenaAssets: true,
        playerEntries: {
          orderBy: { playerIndex: 'asc' },
        },
      },
    });

    if (!arena) {
      return reply.status(404).send({ error: 'Arena not found' });
    }

    // Calculate real-time total pool value using latest market prices
    const poolValue = await calculateRealTimePoolValue(arena.arenaId);

    // Serialize all fields properly
    const response = {
      id: arena.id.toString(),
      arenaId: arena.arenaId.toString(),
      pda: arena.pda,
      status: arena.status,
      statusLabel: ArenaStatusLabels[arena.status as ArenaStatus],
      playerCount: arena.playerCount,
      assetCount: arena.assetCount,
      winningAsset: arena.winningAsset,
      winningAssetSymbol: arena.winningAsset !== null ? getAssetSymbol(arena.winningAsset) : null,
      isSuspended: arena.isSuspended,
      startTimestamp: arena.startTimestamp?.toISOString() || null,
      endTimestamp: arena.endTimestamp?.toISOString() || null,
      totalPoolSol: poolValue.totalPoolSol,
      totalPoolUsd: poolValue.totalPoolUsd,
      createdAt: arena.createdAt.toISOString(),
      arenaAssets: arena.arenaAssets.map((asset) => ({
        id: asset.id.toString(),
        arenaId: asset.arenaId.toString(),
        pda: asset.pda,
        assetIndex: asset.assetIndex,
        assetSymbol: getAssetSymbol(asset.assetIndex),
        playerCount: asset.playerCount,
        startPrice: asset.startPrice ? Number(asset.startPrice) : null,
        endPrice: asset.endPrice ? Number(asset.endPrice) : null,
        // Raw price movement from Solana (10^12 precision). Divide by 1,000,000,000,000 to get percentage.
        priceMovementRaw: asset.priceMovementRaw ? asset.priceMovementRaw.toString() : null,
        // For backward compatibility: convert to BPS (divide raw by 1e10, since BPS = percentage * 100)
        priceMovementBps: asset.priceMovementRaw ? Math.round(Number(asset.priceMovementRaw) / 1e10) : null,
        isWinner: asset.isWinner,
      })),
      playerEntries: arena.playerEntries.map((entry) => ({
        id: entry.id.toString(),
        arenaId: entry.arenaId.toString(),
        pda: entry.pda,
        playerWallet: entry.playerWallet,
        playerIndex: entry.playerIndex,
        assetIndex: entry.assetIndex,
        assetSymbol: getAssetSymbol(entry.assetIndex),
        tokenAmount: entry.tokenAmount ? Number(entry.tokenAmount) : 0,
        usdValue: entry.usdValue ? Number(entry.usdValue) : 0,
        entryPrice: entry.entryPrice ? Number(entry.entryPrice) : undefined,
        actualUsdValue: entry.actualUsdValue ? Number(entry.actualUsdValue) : undefined,
        entryTimestamp: entry.entryTimestamp?.toISOString() || null,
        isWinner: entry.isWinner,
        ownTokensClaimed: entry.ownTokensClaimed,
        rewardsClaimedCount: entry.rewardsClaimedCount,
        rewardsClaimedBitmap: entry.rewardsClaimedBitmap || '0',
      })),
    };

    // Cache with appropriate TTL based on arena status
    // Active arenas: 2 seconds (frequently changing)
    // Ended/Canceled arenas: 60 seconds (immutable)
    // Other statuses: 10 seconds
    let cacheTtl = 10;
    if (arena.status === ArenaStatus.Active) {
      cacheTtl = 2;
    } else if (arena.status === ArenaStatus.Ended || arena.status === ArenaStatus.Canceled) {
      cacheTtl = 60;
    }

    await cacheService.set(cacheKey, response, cacheTtl);
    
    return response;
  });

  // Get arena players
  app.get('/api/v1/arenas/:id/players', async (request, reply) => {
    const { id } = request.params as { id: string };

    const players = await prisma.playerEntry.findMany({
      where: { arenaId: BigInt(id) },
      orderBy: { playerIndex: 'asc' },
    });

    return players.map((entry) => ({
      ...entry,
      arenaId: entry.arenaId.toString(),
      tokenAmount: entry.tokenAmount ? Number(entry.tokenAmount) : 0,
      usdValue: entry.usdValue ? Number(entry.usdValue) : 0,
      entryPrice: entry.entryPrice ? Number(entry.entryPrice) : undefined,
      actualUsdValue: entry.actualUsdValue ? Number(entry.actualUsdValue) : undefined,
      assetSymbol: getAssetSymbol(entry.assetIndex),
    }));
  });

  // Get arena assets
  app.get('/api/v1/arenas/:id/assets', async (request, reply) => {
    const { id } = request.params as { id: string };

    const assets = await prisma.arenaAsset.findMany({
      where: { arenaId: BigInt(id) },
      orderBy: { assetIndex: 'asc' },
    });

    return assets.map((asset) => ({
      ...asset,
      assetSymbol: getAssetSymbol(asset.assetIndex),
    }));
  });

  // Get arena reward claims
  app.get('/api/v1/arenas/:id/claims', async (request) => {
    const { id } = request.params as { id: string };

    const claims = await prisma.rewardClaim.findMany({
      where: { arenaId: BigInt(id) },
      orderBy: { createdAt: 'desc' },
    });

    return claims.map((claim) => ({
      ...claim,
      assetSymbol: getAssetSymbol(claim.assetIndex),
    }));
  });

  // Get arenas by player wallet(s)
  // Supports multiple wallets via comma-separated list
  app.get('/api/v1/arenas/player/:wallets', async (request) => {
    const { wallets } = request.params as { wallets: string };
    const { page = '1', limit = '20' } = request.query as {
      page?: string;
      limit?: string;
    };

    // Parse wallet addresses (comma-separated)
    const walletList = wallets.split(',').map((w) => w.trim()).filter((w) => w.length > 0);

    if (walletList.length === 0) {
      return {
        data: [],
        pagination: { page: 1, limit: parseInt(limit), total: 0, pages: 0 },
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Find all player entries for these wallets
    const playerEntries = await prisma.playerEntry.findMany({
      where: {
        playerWallet: { in: walletList },
      },
      select: {
        arenaId: true,
      },
      distinct: ['arenaId'],
    });

    const arenaIds = playerEntries.map((e) => e.arenaId);

    if (arenaIds.length === 0) {
      return {
        data: [],
        pagination: { page: parseInt(page), limit: parseInt(limit), total: 0, pages: 0 },
      };
    }

    // Get the arenas with full details
    const [arenas, total] = await Promise.all([
      prisma.arena.findMany({
        where: { arenaId: { in: arenaIds } },
        orderBy: { arenaId: 'desc' },
        skip,
        take,
        include: {
          arenaAssets: {
            select: {
              assetIndex: true,
              playerCount: true,
              isWinner: true,
              startPrice: true,
              endPrice: true,
              priceMovementRaw: true,
            },
          },
          playerEntries: {
            select: {
              playerWallet: true,
              playerIndex: true,
              assetIndex: true,
              tokenAmount: true,
              usdValue: true,
              isWinner: true,
              ownTokensClaimed: true,
              entryTimestamp: true,
            },
          },
        },
      }),
      prisma.arena.count({ where: { arenaId: { in: arenaIds } } }),
    ]);

    // Calculate pool values for these arenas
    const poolValues = await calculateRealTimePoolValueBatch(arenaIds);

    return {
      data: arenas.map((arena) => {
        // Find the player's entry in this arena
        const userEntries = arena.playerEntries.filter((e) => walletList.includes(e.playerWallet));
        const userEntry = userEntries[0]; // Primary entry (could have multiple wallets)
        const poolValue = poolValues.get(arena.arenaId.toString()) || { totalPoolSol: 0, totalPoolUsd: 0 };

        return {
          id: arena.id.toString(),
          arenaId: arena.arenaId.toString(),
          pda: arena.pda,
          status: arena.status,
          statusLabel: ArenaStatusLabels[arena.status as ArenaStatus],
          playerCount: arena.playerCount,
          assetCount: arena.assetCount,
          winningAsset: arena.winningAsset,
          winningAssetSymbol: arena.winningAsset !== null ? getAssetSymbol(arena.winningAsset) : null,
          isSuspended: arena.isSuspended,
          startTimestamp: arena.startTimestamp?.toISOString() || null,
          endTimestamp: arena.endTimestamp?.toISOString() || null,
          totalPoolSol: poolValue.totalPoolSol,
          totalPoolUsd: poolValue.totalPoolUsd,
          createdAt: arena.createdAt.toISOString(),
          // User's participation info
          userEntry: userEntry ? {
            playerWallet: userEntry.playerWallet,
            playerIndex: userEntry.playerIndex,
            assetIndex: userEntry.assetIndex,
            assetSymbol: getAssetSymbol(userEntry.assetIndex),
            isWinner: userEntry.isWinner,
            hasClaimed: userEntry.ownTokensClaimed, // For new SOL program
            entryTimestamp: userEntry.entryTimestamp?.toISOString() || null,
          } : null,
          arenaAssets: arena.arenaAssets.map((asset) => ({
            assetIndex: asset.assetIndex,
            assetSymbol: getAssetSymbol(asset.assetIndex),
            playerCount: asset.playerCount,
            isWinner: asset.isWinner,
            startPrice: asset.startPrice ? Number(asset.startPrice) : null,
            endPrice: asset.endPrice ? Number(asset.endPrice) : null,
            priceMovementRaw: asset.priceMovementRaw ? asset.priceMovementRaw.toString() : null,
            priceMovementBps: asset.priceMovementRaw ? Math.round(Number(asset.priceMovementRaw) / 1e10) : null,
          })),
        };
      }),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / take),
      },
    };
  });
}

