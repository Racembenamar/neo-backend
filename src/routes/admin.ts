import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { handleAsync, AppError } from '../middleware/errorHandler';
import { checkPendingUpgrade } from '../services/tier.service';

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

// GET /api/admin/group-points-tournaments - list all Group Points tournaments
adminRouter.get('/group-points-tournaments', handleAsync(async (_req: Request, res: Response) => {
  const tournaments = await prisma.tournament.findMany({
    where: { format: 'group_points' },
    include: {
      store: {
        select: {
          id: true,
          name: true,
          owner: { select: { id: true, name: true, username: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(tournaments);
}));

// PATCH /api/admin/tournaments/:id/toggle-group-points-permission - toggle permission for Group Points tournament
adminRouter.patch('/tournaments/:id/toggle-group-points-permission', handleAsync(async (req: Request, res: Response) => {
  const current = await prisma.tournament.findUnique({ where: { id: String(req.params.id) } });
  if (!current) throw new AppError(404, 'Tournament not found');
  if (current.format !== 'group_points') throw new AppError(400, 'Only Group Points tournaments require permission');

  const newApproved = !current.groupPointsApproved;
  const updated = await prisma.tournament.update({
    where: { id: String(req.params.id) },
    data: {
      groupPointsApproved: newApproved,
      // If we revoke permission, automatically set isActive to false
      ...(!newApproved && { isActive: false }),
    },
  });
  res.json(updated);
}));

// GET /api/admin/users
adminRouter.get('/users', handleAsync(async (req: Request, res: Response) => {
  const { search, role } = req.query;

  // Construct where condition
  const where: Prisma.PlayerWhereInput = {};

  if (role === 'owner') {
    where.ownedStore = { isNot: null };
  } else if (role === 'player') {
    where.ownedStore = null;
  }

  if (search) {
    const searchStr = String(search);
    where.OR = [
      { username: { contains: searchStr, mode: 'insensitive' } },
      { name: { contains: searchStr, mode: 'insensitive' } },
      { phone: { contains: searchStr, mode: 'insensitive' } }
    ];
  }

  const users = await prisma.player.findMany({
    where,
    include: {
      ownedStore: { select: { id: true, name: true } },
      _count: { select: { storeLinks: true, sessions: true } }
    },
    orderBy: { createdAt: 'desc' }
  });

  // Map response to include isStoreOwner flag for ease of use in frontend
  const result = users.map(user => ({
    id: user.id,
    username: user.username,
    name: user.name,
    phone: user.phone,
    avatarSeed: user.avatarSeed,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
    isStoreOwner: !!user.ownedStore,
    ownedStore: user.ownedStore,
    storeCount: user._count.storeLinks,
    sessionCount: user._count.sessions
  }));

  res.json(result);
}));

const updateUserFieldsSchema = z.object({
  name: z.string().min(2).optional(),
  username: z.string().min(3).optional(),
  phone: z.string().optional().nullable(),
  password: z.string().min(6).optional()
});

// PUT /api/admin/users/:id
adminRouter.put('/users/:id', handleAsync(async (req: Request, res: Response) => {
  const playerId = String(req.params.id);
  const { name, username, phone, password } = updateUserFieldsSchema.parse(req.body);

  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) throw new AppError(404, 'User not found');

  if (username && username !== player.username) {
    const existing = await prisma.player.findUnique({ where: { username } });
    if (existing) throw new AppError(409, 'Username already taken');
  }

  const data: Prisma.PlayerUpdateInput = {};
  if (name) data.name = name;
  if (username) data.username = username;
  if (phone !== undefined) data.phone = phone;
  if (password) {
    data.passwordHash = await bcrypt.hash(password, 10);
  }

  const updated = await prisma.player.update({
    where: { id: playerId },
    data,
    select: { id: true, username: true, name: true, phone: true, createdAt: true }
  });

  res.json(updated);
}));

// DELETE /api/admin/users/:id
adminRouter.delete('/users/:id', handleAsync(async (req: Request, res: Response) => {
  const playerId = String(req.params.id);
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { ownedStore: true }
  });
  if (!player) throw new AppError(404, 'User not found');

  await prisma.$transaction(async (tx) => {
    // If player owns a store, cascade delete the store and all store dependencies
    if (player.ownedStore) {
      const storeId = player.ownedStore.id;
      await tx.qrPayment.deleteMany({ where: { storeId } });
      await tx.sessionItem.deleteMany({ where: { session: { storeId } } });
      await tx.session.deleteMany({ where: { storeId } });
      await tx.playerStore.deleteMany({ where: { storeId } });
      await tx.gameType.deleteMany({ where: { storeId } });
      await tx.tierConfig.deleteMany({ where: { storeId } });
      await tx.product.deleteMany({ where: { storeId } });
      await tx.tournamentParticipant.deleteMany({ where: { tournament: { storeId } } });
      await tx.tournament.deleteMany({ where: { storeId } });
      await tx.store.delete({ where: { id: storeId } });
    }

    // Delete player specific records
    await tx.deviceToken.deleteMany({ where: { playerId } });
    await tx.tournamentParticipant.deleteMany({ where: { playerId } });
    await tx.qrPayment.deleteMany({ where: { playerId } });
    await tx.sessionItem.deleteMany({ where: { session: { playerId } } });
    await tx.session.deleteMany({ where: { playerId } });
    await tx.purchase.deleteMany({ where: { playerId } });
    await tx.pendingCashOrder.deleteMany({ where: { playerId } });
    await tx.notification.deleteMany({ where: { playerId } });
    await tx.playerStore.deleteMany({ where: { playerId } });

    // Delete player account
    await tx.player.delete({ where: { id: playerId } });
  });

  res.status(204).send();
}));

// GET /api/admin/users/:id/points
adminRouter.get('/users/:id/points', handleAsync(async (req: Request, res: Response) => {
  const playerId = String(req.params.id);
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) throw new AppError(404, 'User not found');

  const storePoints = await prisma.playerStore.findMany({
    where: { playerId },
    include: {
      store: { select: { id: true, name: true } }
    },
    orderBy: { joinedAt: 'desc' }
  });

  res.json(storePoints);
}));

const updateUserPointsSchema = z.object({
  storeId: z.string(),
  totalPoints: z.number().int().nonnegative(),
  tier: z.number().int().min(1).max(5)
});

// PUT /api/admin/users/:id/points
adminRouter.put('/users/:id/points', handleAsync(async (req: Request, res: Response) => {
  const playerId = String(req.params.id);
  const { storeId, totalPoints, tier } = updateUserPointsSchema.parse(req.body);

  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) throw new AppError(404, 'User not found');

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new AppError(404, 'Store not found');

  const tierConfig = await prisma.tierConfig.findUnique({ where: { storeId } });
  const pendingUpgrade = tierConfig ? checkPendingUpgrade(totalPoints, tier, tierConfig) : false;

  const currentLink = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } }
  });
  const oldPoints = currentLink?.totalPoints ?? 0;
  const oldTier = currentLink?.tier ?? 1;

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.playerStore.upsert({
      where: { playerId_storeId: { playerId, storeId } },
      update: { totalPoints, tier, pendingUpgrade },
      create: { playerId, storeId, totalPoints, tier, pendingUpgrade }
    });

    const diff = totalPoints - oldPoints;
    if (diff !== 0) {
      await tx.purchase.create({
        data: {
          playerId,
          storeId,
          productName: diff > 0 ? 'Points Added by Admin' : 'Points Deducted by Admin',
          pointsSpent: diff < 0 ? Math.abs(diff) : 0,
          pointsEarned: diff > 0 ? diff : 0,
        }
      });
    }

    if (tier !== oldTier) {
      await tx.purchase.create({
        data: {
          playerId,
          storeId,
          productName: `Tier Changed by Admin (Tier ${oldTier} -> ${tier})`,
          pointsSpent: 0,
          pointsEarned: 0,
        }
      });
    }

    return updated;
  });

  res.json(result);
}));


