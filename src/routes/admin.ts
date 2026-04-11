import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { handleAsync, AppError } from '../middleware/errorHandler';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin'));

const createStoreSchema = z.object({
  storeName: z.string().min(2),
  address: z.string().optional(),
  phone: z.string().optional(),
  ownerUsername: z.string().min(3),
  ownerPassword: z.string().min(6),
  ownerName: z.string().min(2),
});

// GET /api/admin/dashboard
adminRouter.get('/dashboard', handleAsync(async (_req: Request, res: Response) => {
  const [totalStores, totalPlayers, totalSessions] = await Promise.all([
    prisma.store.count(),
    prisma.player.count(),
    prisma.session.count(),
  ]);
  res.json({ totalStores, totalPlayers, totalSessions });
}));

// GET /api/admin/stores
adminRouter.get('/stores', handleAsync(async (_req: Request, res: Response) => {
  const stores = await prisma.store.findMany({
    include: {
      owner: { select: { id: true, username: true, name: true, phone: true } },
      _count: { select: { playerLinks: true, sessions: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(stores);
}));

// POST /api/admin/stores - create store + owner account
adminRouter.post('/stores', handleAsync(async (req: Request, res: Response) => {
  const { storeName, address, phone, ownerUsername, ownerPassword, ownerName } =
    createStoreSchema.parse(req.body);

  const existing = await prisma.player.findUnique({ where: { username: ownerUsername } });
  if (existing) throw new AppError(409, 'Username already taken');

  const passwordHash = await bcrypt.hash(ownerPassword, 10);

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const owner = await tx.player.create({
      data: { username: ownerUsername, passwordHash, name: ownerName, phone },
    });
    const store = await tx.store.create({
      data: {
        name: storeName,
        address,
        phone,
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
    return { owner, store };
  });

  res.status(201).json(result);
}));

// PATCH /api/admin/stores/:id/toggle
adminRouter.patch('/stores/:id/toggle', handleAsync(async (req: Request, res: Response) => {
  const store = await prisma.store.findUnique({ where: { id: String(req.params.id) } });
  if (!store) throw new AppError(404, 'Store not found');

  const updated = await prisma.store.update({
    where: { id: String(req.params.id) },
    data: { isActive: !store.isActive },
  });
  res.json(updated);
}));

const updateStoreSchema = z.object({
  name: z.string().min(2).optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
});

// PUT /api/admin/stores/:id - update store details
adminRouter.put('/stores/:id', handleAsync(async (req: Request, res: Response) => {
  const { name, address, phone } = updateStoreSchema.parse(req.body);
  
  const store = await prisma.store.findUnique({ where: { id: String(req.params.id) } });
  if (!store) throw new AppError(404, 'Store not found');

  const updated = await prisma.store.update({
    where: { id: String(req.params.id) },
    data: { ...(name && { name }), address, phone },
  });
  res.json(updated);
}));

// DELETE /api/admin/stores/:id - delete store
adminRouter.delete('/stores/:id', handleAsync(async (req: Request, res: Response) => {
  const storeId = String(req.params.id);
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new AppError(404, 'Store not found');

  await prisma.$transaction(async (tx) => {
    // Manually cascade delete dependent records
    await tx.qrPayment.deleteMany({ where: { storeId } });
    await tx.sessionItem.deleteMany({ where: { session: { storeId } } });
    await tx.session.deleteMany({ where: { storeId } });
    await tx.playerStore.deleteMany({ where: { storeId } });
    await tx.gameType.deleteMany({ where: { storeId } });
    await tx.tierConfig.deleteMany({ where: { storeId } });
    await tx.product.deleteMany({ where: { storeId } });
    await tx.tournamentParticipant.deleteMany({ where: { tournament: { storeId } } });
    await tx.tournament.deleteMany({ where: { storeId } });
    
    // Finally delete the store
    await tx.store.delete({ where: { id: storeId } });
    
    // We do NOT delete the player (owner) account, as they might have other roles or histories,
    // or maybe we should? For now keeping it safe and retaining the user account.
  });

  res.status(204).send();
}));
