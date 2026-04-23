import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const config = await prisma.tierConfig.findMany();
  console.log('TIER CONFIG', config);
}
main().finally(() => prisma.$disconnect());
