import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ASSETS = [
  { index: 0, symbol: 'SOL', name: 'Solana' },
  { index: 1, symbol: 'TRUMP', name: 'Trump' },
  { index: 2, symbol: 'PUMP', name: 'Pump' },
  { index: 3, symbol: 'BONK', name: 'Bonk' },
  { index: 4, symbol: 'JUP', name: 'Jupiter' },
  { index: 5, symbol: 'PENGU', name: 'Pengu' },
  { index: 6, symbol: 'PYTH', name: 'Pyth' },
  { index: 7, symbol: 'HNT', name: 'Helium' },
  { index: 8, symbol: 'FARTCOIN', name: 'Fartcoin' },
  { index: 9, symbol: 'RAY', name: 'Raydium' },
  { index: 10, symbol: 'WIF', name: 'Dogwifhat' },
  { index: 11, symbol: 'RENDER', name: 'Render' },
  { index: 12, symbol: 'ONDO', name: 'Ondo' },
  { index: 13, symbol: 'MEW', name: 'Mew' },
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

