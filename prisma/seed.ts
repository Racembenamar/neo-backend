import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding NEO database...');

  const adminHash = await bcrypt.hash('admin123', 10);
  const admin = await prisma.admin.upsert({
    where: { username: 'superadmin' },
    update: {},
    create: { username: 'superadmin', passwordHash: adminHash },
  });
  console.log(`✅ Admin created: ${admin.username}`);

  // Create demo store owner (also a Player entity)
  const ownerHash = await bcrypt.hash('owner123', 10);
  const owner = await prisma.player.upsert({
    where: { username: 'owner_demo' },
    update: {},
    create: {
      username: 'owner_demo',
      passwordHash: ownerHash,
      name: 'Demo Owner',
      phone: '+21612345678',
    },
  });

  // Create demo store
  const store = await prisma.store.upsert({
    where: { ownerId: owner.id },
    update: {},
    create: {
      name: 'NEO Game Zone',
      address: 'Tunis, Tunisia',
      phone: '+21612345678',
      ownerId: owner.id,
      tierConfig: {
        create: {
          tier1Threshold: 0,
          tier2Threshold: 1000,
          tier3Threshold: 5000,
          tier1Pct: 5,
          tier2Pct: 10,
          tier3Pct: 15,
          pointsPerDt: 50,
        },
      },
    },
  });
  console.log(`✅ Store created: ${store.name}`);

  // Create game types
  const games = [
    { name: 'Snooker', pricingMode: 'hourly', pricePerUnit: 8 },
    { name: 'Billard (8 Pool)', pricingMode: 'per_game', pricePerUnit: 2 },
    { name: 'Babyfoot', pricingMode: 'per_game', pricePerUnit: 1 },
    { name: 'PS4', pricingMode: 'hourly', pricePerUnit: 5 },
    { name: 'PS5', pricingMode: 'hourly', pricePerUnit: 6 },
  ];

  for (const game of games) {
    await prisma.gameType.upsert({
      where: { id: `seed-game-${game.name.toLowerCase().replace(/\s/g, '-')}` },
      update: {},
      create: {
        id: `seed-game-${game.name.toLowerCase().replace(/\s/g, '-')}`,
        storeId: store.id,
        name: game.name,
        pricingMode: game.pricingMode,
        pricePerUnit: game.pricePerUnit,
      },
    });
  }
  console.log(`✅ ${games.length} game types created`);

  // Create demo players
  const playerHash = await bcrypt.hash('player123', 10);
  const players = [
    { username: 'player_racem', name: 'Racem', phone: '+21698765432' },
    { username: 'player_ali', name: 'Ali', phone: '+21698765433' },
  ];

  for (const p of players) {
    const player = await prisma.player.upsert({
      where: { username: p.username },
      update: {},
      create: { username: p.username, passwordHash: playerHash, name: p.name, phone: p.phone },
    });

    await prisma.playerStore.upsert({
      where: { playerId_storeId: { playerId: player.id, storeId: store.id } },
      update: {},
      create: { playerId: player.id, storeId: store.id, tier: 1, totalPoints: 0 },
    });
    console.log(`✅ Player created: ${player.name}`);
  }

  console.log('\n🎮 NEO database seeded successfully!');
  console.log('\n📝 Login credentials:');
  console.log('  Admin     → username: superadmin  | password: admin123');
  console.log('  Owner     → username: owner_demo   | password: owner123');
  console.log('  Player 1  → username: player_racem | password: player123');
  console.log('  Player 2  → username: player_ali   | password: player123');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
