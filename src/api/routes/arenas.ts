import { FastifyInstance } from 'fastify';
import prisma from '../../db';
import { ArenaStatusLabels, ArenaStatus, getAssetSymbol } from '../../types/accounts';

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

    return {
      data: arenas.map((arena) => ({
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
        totalPoolUsd: arena.totalPoolUsd ? Number(arena.totalPoolUsd) : 0,
        createdAt: arena.createdAt.toISOString(),
        arenaAssets: arena.arenaAssets.map((asset) => ({
          assetIndex: asset.assetIndex,
          assetSymbol: getAssetSymbol(asset.assetIndex),
          playerCount: asset.playerCount,
          isWinner: asset.isWinner,
        })),
      })),
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
          in: [ArenaStatus.Waiting, ArenaStatus.Ready, ArenaStatus.Active, ArenaStatus.Starting],
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

  // Get current arena (the one accepting new players - Waiting status)
  // If no waiting arena exists, returns null (frontend should show "Be the first!")
  app.get('/api/v1/arenas/current', async () => {
    // Find the arena that is currently accepting players (Waiting or Ready status)
    const currentArena = await prisma.arena.findFirst({
      where: {
        status: {
          in: [ArenaStatus.Waiting, ArenaStatus.Ready],
        },
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
            entryTimestamp: true,
          },
          orderBy: { playerIndex: 'asc' },
        },
      },
    });

    if (!currentArena) {
      // No arena currently accepting players - next player will start a new one
      // Get the protocol state to know what the next arena ID would be
      const protocolState = await prisma.protocolState.findFirst();
      
      return {
        exists: false,
        nextArenaId: protocolState ? (Number(protocolState.currentArenaId) + 1).toString() : '1',
        message: 'No arena currently accepting players. Be the first to start a new arena!',
      };
    }

    // Serialize BigInt fields to strings for JSON response
    return {
      exists: true,
      arena: {
        id: currentArena.id.toString(),
        arenaId: currentArena.arenaId.toString(),
        pda: currentArena.pda,
        status: currentArena.status,
        statusLabel: ArenaStatusLabels[currentArena.status as ArenaStatus],
        playerCount: currentArena.playerCount,
        assetCount: currentArena.assetCount,
        totalPoolUsd: currentArena.totalPoolUsd ? Number(currentArena.totalPoolUsd) : 0,
        startTimestamp: currentArena.startTimestamp?.toISOString() || null,
        endTimestamp: currentArena.endTimestamp?.toISOString() || null,
        winningAsset: currentArena.winningAsset,
        maxPlayers: 10, // From program config
        playerEntries: currentArena.playerEntries.map((entry) => ({
          playerWallet: entry.playerWallet,
          playerIndex: entry.playerIndex,
          assetIndex: entry.assetIndex,
          assetSymbol: getAssetSymbol(entry.assetIndex),
          tokenAmount: entry.tokenAmount ? Number(entry.tokenAmount) : 0,
          usdValue: entry.usdValue ? Number(entry.usdValue) : 0,
          entryTimestamp: entry.entryTimestamp?.toISOString() || null,
        })),
        arenaAssets: currentArena.arenaAssets.map((asset) => ({
          assetIndex: asset.assetIndex,
          assetSymbol: getAssetSymbol(asset.assetIndex),
          playerCount: asset.playerCount,
        })),
      },
    };
  });

  // Check if a specific wallet is already in the current waiting arena
  app.get('/api/v1/arenas/current/check-player/:wallet', async (request) => {
    const { wallet } = request.params as { wallet: string };

    // Find current waiting/ready arena
    const currentArena = await prisma.arena.findFirst({
      where: {
        status: {
          in: [ArenaStatus.Waiting, ArenaStatus.Ready],
        },
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

  // Get arena by ID
  app.get('/api/v1/arenas/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

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

    // Serialize all fields properly
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
      totalPoolUsd: arena.totalPoolUsd ? Number(arena.totalPoolUsd) : 0,
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
        priceMovementBps: asset.priceMovementBps,
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
        entryTimestamp: entry.entryTimestamp?.toISOString() || null,
        isWinner: entry.isWinner,
        ownTokensClaimed: entry.ownTokensClaimed,
        rewardsClaimedCount: entry.rewardsClaimedCount,
        rewardsClaimedBitmap: entry.rewardsClaimedBitmap || '0',
      })),
    };
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
              priceMovementBps: true,
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
              entryTimestamp: true,
            },
          },
        },
      }),
      prisma.arena.count({ where: { arenaId: { in: arenaIds } } }),
    ]);

    return {
      data: arenas.map((arena) => {
        // Find the player's entry in this arena
        const userEntries = arena.playerEntries.filter((e) => walletList.includes(e.playerWallet));
        const userEntry = userEntries[0]; // Primary entry (could have multiple wallets)

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
          totalPoolUsd: arena.totalPoolUsd ? Number(arena.totalPoolUsd) : 0,
          createdAt: arena.createdAt.toISOString(),
          // User's participation info
          userEntry: userEntry ? {
            playerWallet: userEntry.playerWallet,
            playerIndex: userEntry.playerIndex,
            assetIndex: userEntry.assetIndex,
            assetSymbol: getAssetSymbol(userEntry.assetIndex),
            tokenAmount: userEntry.tokenAmount ? Number(userEntry.tokenAmount) : 0,
            usdValue: userEntry.usdValue ? Number(userEntry.usdValue) : 0,
            isWinner: userEntry.isWinner,
            entryTimestamp: userEntry.entryTimestamp?.toISOString() || null,
          } : null,
          arenaAssets: arena.arenaAssets.map((asset) => ({
            assetIndex: asset.assetIndex,
            assetSymbol: getAssetSymbol(asset.assetIndex),
            playerCount: asset.playerCount,
            isWinner: asset.isWinner,
            startPrice: asset.startPrice ? Number(asset.startPrice) : null,
            endPrice: asset.endPrice ? Number(asset.endPrice) : null,
            priceMovementBps: asset.priceMovementBps,
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

