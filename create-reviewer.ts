import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function createReviewer() {
  const username = 'google_reviewer';
  const password = 'google_password_2024';
  const name = 'Google Play Reviewer';

  const existing = await prisma.player.findUnique({ where: { username } });
  
  if (existing) {
    console.log('Reviewer account already exists.');
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  
  const player = await prisma.player.create({
    data: {
      username,
      passwordHash,
      name,
    }
  });

  console.log('✅ Reviewer account created successfully!');
  console.log('Username:', username);
  console.log('Password:', password);
}

createReviewer()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
