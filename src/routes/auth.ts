import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { handleAsync } from '../middleware/errorHandler';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: z.enum(['admin', 'owner', 'player']),
});

// POST /api/auth/login
authRouter.post('/login', handleAsync(async (req: Request, res: Response) => {
  const { username, password, role } = loginSchema.parse(req.body);

  let user: { id: string; username: string; passwordHash: string; name?: string } | null = null;
  let storeId: string | undefined = undefined;

  if (role === 'admin') {
    user = await prisma.admin.findUnique({ where: { username } });
  } else if (role === 'owner') {
    const player = await prisma.player.findUnique({
      where: { username },
      include: { ownedStore: true },
    });
    if (player) {
      user = player;
      storeId = player.ownedStore?.id;
    }
  } else {
    user = await prisma.player.findUnique({ where: { username } });
  }

  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign(
    { id: user.id, role, storeId },
    process.env.JWT_SECRET!,
    { expiresIn: '30d' }
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      name: (user as any).name ?? user.username,
      role,
      storeId,
    },
  });
}));

// GET /api/auth/me
authRouter.get('/me', requireAuth, handleAsync(async (req: Request, res: Response) => {
  const { id, role } = req.user!;

  if (role === 'admin') {
    const admin = await prisma.admin.findUnique({ where: { id } });
    res.json({ id: admin!.id, username: admin!.username, role });
    return;
  }

  const player = await prisma.player.findUnique({
    where: { id },
    include: { ownedStore: true, storeLinks: true },
  });
  res.json({
    id: player!.id,
    username: player!.username,
    name: player!.name,
    phone: player!.phone,
    role,
    storeId: player!.ownedStore?.id,
    stores: player!.storeLinks,
  });
}));
