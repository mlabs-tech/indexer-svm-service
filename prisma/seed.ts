import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ASSETS = [
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
];

async function main() {
  console.log('Seeding database...');

  // Upsert assets
  for (const asset of ASSETS) {
    await prisma.asset.upsert({
      where: { index: asset.index },
      update: { symbol: asset.symbol, name: asset.name },
      create: {
        index: asset.index,
        symbol: asset.symbol,
        name: asset.name,
        decimals: 9,
      },
    });
    console.log(`  ✓ Asset ${asset.symbol} (index ${asset.index})`);
  }

  // Initialize asset stats
  for (const asset of ASSETS) {
    await prisma.assetStats.upsert({
      where: { assetIndex: asset.index },
      update: {},
      create: {
        assetIndex: asset.index,
      },
    });
  }

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

