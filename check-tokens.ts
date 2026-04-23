import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const tokens = await prisma.deviceToken.findMany({ include: { player: { select: { username: true } } } });
  console.log('TOKENS', JSON.stringify(tokens, null, 2));
}
main().finally(() => prisma.$disconnect());
