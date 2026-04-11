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
  password: z.string().min(1)
});

const playerRegisterSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  name: z.string().min(2),
  phone: z.string().optional(),
});

// POST /api/auth/register
authRouter.post('/register', handleAsync(async (req: Request, res: Response) => {
  const { username, password, name, phone } = playerRegisterSchema.parse(req.body);
  
  const existing = await prisma.player.findUnique({ where: { username } });
  if (existing) {
    res.status(400).json({ error: 'Username already exists' });
    return;
  }
  const existAdmin = await prisma.admin.findUnique({ where: { username } });
  if (existAdmin) {
    res.status(400).json({ error: 'Username already exists' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const player = await prisma.player.create({
    data: { username, passwordHash, name, phone }
  });

  const token = jwt.sign(
    { id: player.id, role: 'player' },
    process.env.JWT_SECRET!,
    { expiresIn: '30d' }
  );

  res.status(201).json({
    token,
    user: {
      id: player.id,
      username: player.username,
      name: player.name,
      avatarSeed: player.avatarSeed,
      role: 'player',
      storeId: undefined,
    },
  });
}));

// POST /api/auth/login
authRouter.post('/login', handleAsync(async (req: Request, res: Response) => {
  const { username, password } = loginSchema.parse(req.body);

  let user: any = null;
  let role: string = '';
  let storeId: string | undefined = undefined;

  const admin = await prisma.admin.findUnique({ where: { username } });
  
  if (admin) {
    user = admin;
    role = 'admin';
  } else {
    const player = await prisma.player.findUnique({
      where: { username },
      include: { ownedStore: true },
    });
    if (player) {
      user = player;
      role = player.ownedStore ? 'owner' : 'player';
      if (player.ownedStore) {
        storeId = player.ownedStore.id;
      }
    }
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
      name: user.name ?? user.username,
      avatarSeed: user.avatarSeed,
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
    avatarSeed: player!.avatarSeed,
    role,
    storeId: player!.ownedStore?.id,
    stores: player!.storeLinks,
  });
}));
