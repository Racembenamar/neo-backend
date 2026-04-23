import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const stores = await prisma.store.findMany();
  console.log('STORES', stores);
}
main().finally(() => prisma.$disconnect());
