import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Preparing Google Reviewer Account ---');

  // 1. Find the reviewer
  const reviewer = await prisma.player.findUnique({
    where: { username: 'google_reviewer' }
  });

  if (!reviewer) {
    console.error('Reviewer account not found. Please run create-reviewer.ts first.');
    return;
  }

  // 2. Find a store (NEO Game Zone)
  const store = await prisma.store.findFirst({
    where: { name: 'NEO Game Zone' }
  });

  if (!store) {
    console.error('NEO Game Zone store not found.');
    return;
  }

  // 3. Link Reviewer to Store with data
  const playerStore = await prisma.playerStore.upsert({
    where: {
      playerId_storeId: {
        playerId: reviewer.id,
        storeId: store.id
      }
    },
    update: {
      totalPoints: 12500, // Enough for Tier 4 (Diamond/Platinum)
      tier: 4
    },
    create: {
      playerId: reviewer.id,
      storeId: store.id,
      totalPoints: 12500,
      tier: 4
    }
  });

  console.log(`Linked ${reviewer.username} to ${store.name} with 12,500 points.`);

  // 4. Add some Purchase History
  await prisma.purchase.createMany({
    data: [
      {
        playerId: reviewer.id,
        storeId: store.id,
        productName: 'Boisson Energisante',
        pointsSpent: 250,
      },
      {
        playerId: reviewer.id,
        storeId: store.id,
        productName: 'Heure de jeu PS5',
        pointsSpent: 1000,
      }
    ]
  });

  // 5. Add to a Tournament
  const tournament = await prisma.tournament.findFirst({
    where: { storeId: store.id }
  });

  if (tournament) {
    await prisma.tournamentParticipant.upsert({
      where: {
        tournamentId_playerId: {
          tournamentId: tournament.id,
          playerId: reviewer.id
        }
      },
      update: { status: 'accepted' },
      create: {
        tournamentId: tournament.id,
        playerId: reviewer.id,
        status: 'accepted'
      }
    });
    console.log(`Registered reviewer for tournament: ${tournament.name}`);
  }

  console.log('--- Done! Reviewer account is now "Live" ---');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
