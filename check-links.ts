import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const links = await prisma.playerStore.findMany({ where: { playerId: '0f29cc8d-83ff-47a6-b3ba-baffaa45f3eb' } });
  console.log('LINKS', JSON.stringify(links, null, 2));
}
main().finally(() => prisma.$disconnect());
