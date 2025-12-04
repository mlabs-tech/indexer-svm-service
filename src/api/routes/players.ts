import { FastifyInstance } from 'fastify';
import prisma from '../../db';
import { getAssetSymbol, ArenaStatusLabels, ArenaStatus } from '../../types/accounts';

export async function registerPlayerRoutes(app: FastifyInstance): Promise<void> {
  // Get player profile
  app.get('/api/v1/players/:wallet', async (request, reply) => {
    const { wallet } = request.params as { wallet: string };

    const stats = await prisma.playerStats.findUnique({
      where: { playerWallet: wallet },
    });

    if (!stats) {
      return reply.status(404).send({ error: 'Player not found' });
    }

    // Get recent entries
    const recentEntries = await prisma.playerEntry.findMany({
      where: { playerWallet: wallet },
      orderBy: { entryTimestamp: 'desc' },
      take: 5,
      include: {
        arena: {
          select: {
            arenaId: true,
            status: true,
            winningAsset: true,
          },
        },
      },
    });

    return {
      wallet,
      stats: {
        ...stats,
        netProfit: Number(stats.totalUsdWon) - Number(stats.totalUsdLost),
      },
      recentArenas: recentEntries.map((entry) => ({
        arenaId: entry.arena.arenaId.toString(),
        status: ArenaStatusLabels[entry.arena.status as ArenaStatus],
        assetIndex: entry.assetIndex,
        assetSymbol: getAssetSymbol(entry.assetIndex),
        usdValue: entry.usdValue,
        isWinner: entry.isWinner,
        entryTimestamp: entry.entryTimestamp,
      })),
    };
  });

  // Get player arena history
  app.get('/api/v1/players/:wallet/history', async (request) => {
    const { wallet } = request.params as { wallet: string };
    const { page = '1', limit = '20' } = request.query as {
      page?: string;
      limit?: string;
    };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const [entries, total] = await Promise.all([
      prisma.playerEntry.findMany({
        where: { playerWallet: wallet },
        orderBy: { entryTimestamp: 'desc' },
        skip,
        take,
        include: {
          arena: {
            select: {
              arenaId: true,
              status: true,
              winningAsset: true,
              totalPoolUsd: true,
              endTimestamp: true,
            },
          },
        },
      }),
      prisma.playerEntry.count({ where: { playerWallet: wallet } }),
    ]);

    return {
      data: entries.map((entry) => ({
        arenaId: entry.arena.arenaId.toString(),
        status: ArenaStatusLabels[entry.arena.status as ArenaStatus],
        assetIndex: entry.assetIndex,
        assetSymbol: getAssetSymbol(entry.assetIndex),
        tokenAmount: entry.tokenAmount,
        usdValue: entry.usdValue,
        isWinner: entry.isWinner,
        ownTokensClaimed: entry.ownTokensClaimed,
        rewardsClaimedCount: entry.rewardsClaimedCount,
        entryTimestamp: entry.entryTimestamp,
        arenaEndTimestamp: entry.arena.endTimestamp,
        totalPoolUsd: entry.arena.totalPoolUsd,
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / take),
      },
    };
  });

  // Get player stats
  app.get('/api/v1/players/:wallet/stats', async (request, reply) => {
    const { wallet } = request.params as { wallet: string };

    const stats = await prisma.playerStats.findUnique({
      where: { playerWallet: wallet },
    });

    if (!stats) {
      return reply.status(404).send({ error: 'Player not found' });
    }

    // Get asset breakdown
    const assetBreakdown = await prisma.playerEntry.groupBy({
      by: ['assetIndex'],
      where: { playerWallet: wallet },
      _count: { assetIndex: true },
      _sum: { usdValue: true },
    });

    const assetWins = await prisma.playerEntry.groupBy({
      by: ['assetIndex'],
      where: { playerWallet: wallet, isWinner: true },
      _count: { assetIndex: true },
    });

    const assetWinsMap = new Map(assetWins.map((a) => [a.assetIndex, a._count.assetIndex]));

    return {
      ...stats,
      netProfit: Number(stats.totalUsdWon) - Number(stats.totalUsdLost),
      favoriteAssetSymbol: stats.favoriteAsset !== null ? getAssetSymbol(stats.favoriteAsset) : null,
      assetBreakdown: assetBreakdown.map((ab) => ({
        assetIndex: ab.assetIndex,
        assetSymbol: getAssetSymbol(ab.assetIndex),
        timesPlayed: ab._count.assetIndex,
        timesWon: assetWinsMap.get(ab.assetIndex) || 0,
        totalUsdWagered: ab._sum.usdValue,
      })),
    };
  });

  // Get player reward claims
  app.get('/api/v1/players/:wallet/claims', async (request) => {
    const { wallet } = request.params as { wallet: string };
    const { page = '1', limit = '20' } = request.query as {
      page?: string;
      limit?: string;
    };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const [claims, total] = await Promise.all([
      prisma.rewardClaim.findMany({
        where: { winnerWallet: wallet },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.rewardClaim.count({ where: { winnerWallet: wallet } }),
    ]);

    return {
      data: claims.map((claim) => ({
        ...claim,
        arenaId: claim.arenaId.toString(),
        assetSymbol: getAssetSymbol(claim.assetIndex),
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / take),
      },
    };
  });
}

