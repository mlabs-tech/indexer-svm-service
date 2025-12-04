import { FastifyInstance } from 'fastify';
import prisma from '../../db';
import { getAssetSymbol } from '../../types/accounts';

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  // Global protocol stats
  app.get('/api/v1/stats', async () => {
    const [
      protocolState,
      totalArenas,
      totalPlayers,
      totalVolume,
      activeArenas,
    ] = await Promise.all([
      prisma.protocolState.findFirst(),
      prisma.arena.count(),
      prisma.playerStats.count(),
      prisma.playerEntry.aggregate({
        _sum: { usdValue: true },
      }),
      prisma.arena.count({
        where: { status: { in: [1, 2, 3, 6] } },
      }),
    ]);

    return {
      currentArenaId: protocolState?.currentArenaId.toString() || '0',
      isPaused: protocolState?.isPaused || false,
      arenaDuration: protocolState?.arenaDuration || 60,
      totalArenas,
      activeArenas,
      totalPlayers,
      totalVolumeUsd: totalVolume._sum.usdValue || 0,
    };
  });

  // Daily stats for last N days
  app.get('/api/v1/stats/daily', async (request) => {
    const { days = '30' } = request.query as { days?: string };

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const dailyStats = await prisma.dailyStats.findMany({
      where: {
        date: { gte: startDate },
      },
      orderBy: { date: 'asc' },
    });

    return dailyStats;
  });

  // Asset performance stats
  app.get('/api/v1/stats/assets', async () => {
    const assetStats = await prisma.assetStats.findMany({
      orderBy: { timesChosen: 'desc' },
    });

    return assetStats.map((stat) => ({
      ...stat,
      symbol: getAssetSymbol(stat.assetIndex),
    }));
  });

  // Leaderboard
  app.get('/api/v1/leaderboard', async (request) => {
    const { limit = '100', sortBy = 'wins' } = request.query as {
      limit?: string;
      sortBy?: 'wins' | 'profit' | 'winRate';
    };

    let orderBy: any;
    switch (sortBy) {
      case 'profit':
        orderBy = [
          { totalUsdWon: 'desc' },
          { totalWins: 'desc' },
        ];
        break;
      case 'winRate':
        orderBy = [
          { winRate: 'desc' },
          { totalWins: 'desc' },
        ];
        break;
      default:
        orderBy = { totalWins: 'desc' };
    }

    const players = await prisma.playerStats.findMany({
      where: { totalArenasPlayed: { gt: 0 } },
      orderBy,
      take: parseInt(limit),
    });

    return players.map((player, index) => ({
      rank: index + 1,
      wallet: player.playerWallet,
      totalWins: player.totalWins,
      totalLosses: player.totalLosses,
      totalArenasPlayed: player.totalArenasPlayed,
      winRate: player.winRate,
      totalUsdWon: player.totalUsdWon,
      totalUsdLost: player.totalUsdLost,
      netProfit: Number(player.totalUsdWon) - Number(player.totalUsdLost),
      favoriteAsset: player.favoriteAsset !== null ? getAssetSymbol(player.favoriteAsset) : null,
      lastPlayedAt: player.lastPlayedAt,
    }));
  });

  // Weekly leaderboard
  app.get('/api/v1/leaderboard/weekly', async (request) => {
    const { limit = '50' } = request.query as { limit?: string };

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    // Get player entries from last week
    const weeklyData = await prisma.playerEntry.groupBy({
      by: ['playerWallet'],
      where: {
        entryTimestamp: { gte: oneWeekAgo },
      },
      _count: { id: true },
      _sum: { usdValue: true },
    });

    // Get wins for these players
    const weeklyWins = await prisma.playerEntry.groupBy({
      by: ['playerWallet'],
      where: {
        entryTimestamp: { gte: oneWeekAgo },
        isWinner: true,
      },
      _count: { id: true },
    });

    const winsMap = new Map(weeklyWins.map((w) => [w.playerWallet, w._count.id]));

    const leaderboard = weeklyData
      .map((entry) => {
        const wins = winsMap.get(entry.playerWallet) || 0;
        const played = entry._count.id;
        return {
          wallet: entry.playerWallet,
          arenasPlayed: played,
          wins,
          losses: played - wins,
          winRate: played > 0 ? ((wins / played) * 100).toFixed(2) : '0.00',
          volumeUsd: entry._sum.usdValue,
        };
      })
      .sort((a, b) => b.wins - a.wins)
      .slice(0, parseInt(limit))
      .map((entry, index) => ({ rank: index + 1, ...entry }));

    return leaderboard;
  });
}

