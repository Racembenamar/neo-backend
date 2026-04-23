import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { handleAsync, AppError } from '../middleware/errorHandler';
import { z } from 'zod';

export const playerRouter = Router();
playerRouter.use(requireAuth, requireRole('player', 'owner'));

// GET /api/player/stores - list stores this player belongs to
playerRouter.get('/stores', handleAsync(async (req: Request, res: Response) => {
  const links = await prisma.playerStore.findMany({
    where: { playerId: req.user!.id },
    include: {
      store: {
        select: { id: true, name: true, address: true, phone: true, logoUrl: true, isActive: true },
      },
    },
  });
  res.json(links);
}));

// GET /api/player/all-stores - list ALL active stores
playerRouter.get('/all-stores', handleAsync(async (req: Request, res: Response) => {
  const stores = await prisma.store.findMany({
    where: { isActive: true },
    select: { id: true, name: true, address: true, phone: true, logoUrl: true },
    orderBy: { name: 'asc' },
  });
  res.json(stores);
}));

// POST /api/player/join-store - select/join a store
const joinStoreSchema = z.object({ storeId: z.string().min(1) });
playerRouter.post('/join-store', handleAsync(async (req: Request, res: Response) => {
  const { storeId } = joinStoreSchema.parse(req.body);
  const playerId = req.user!.id;

  const store = await prisma.store.findUnique({ where: { id: storeId, isActive: true } });
  if (!store) throw new AppError(404, 'Store not found or inactive');

  const link = await prisma.playerStore.upsert({
    where: { playerId_storeId: { playerId, storeId } },
    update: {}, // do nothing if exists
    create: { playerId, storeId, tier: 1, totalPoints: 0 },
  });

  res.json({ success: true, link });
}));

// GET /api/player/stats/:storeId
playerRouter.get('/stats/:storeId', handleAsync(async (req: Request, res: Response) => {
  const storeId = String(req.params.storeId);
  const playerId = req.user!.id;

  const link = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } },
    include: { store: { include: { tierConfig: true } } },
  });
  if (!link) throw new AppError(404, 'Not enrolled in this store');

  const sessions = await prisma.session.findMany({
    where: { playerId, storeId: String(storeId) },
    select: { totalAmount: true, pointsEarned: true, createdAt: true },
  });

  const totalSpent = sessions.reduce((s: number, sess: { totalAmount: number }) => s + sess.totalAmount, 0);
  const totalSessions = sessions.length;

  res.json({
    tier: link.tier,
    totalPoints: link.totalPoints,
    pendingUpgrade: link.pendingUpgrade,
    totalSpent: +totalSpent.toFixed(3),
    totalSessions,
    tierConfig: link.store.tierConfig,
  });
}));

// GET /api/player/sessions/:storeId
playerRouter.get('/sessions/:storeId', handleAsync(async (req: Request, res: Response) => {
  const storeId = String(req.params.storeId);
  const sessions = await prisma.session.findMany({
    where: { playerId: req.user!.id, storeId: String(storeId) },
    include: {
      items: { include: { gameType: { select: { name: true, pricingMode: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(sessions);
}));

// GET /api/player/activity/:storeId - combined feed
playerRouter.get('/activity/:storeId', handleAsync(async (req: Request, res: Response) => {
  const storeId = String(req.params.storeId);
  const playerId = req.user!.id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 5;
  const skip = (page - 1) * limit;

  // Fetch skip + limit + 1 to detect hasMore
  const fetchLimit = skip + limit + 1;

  const [sessions, purchases, qrPayments] = await Promise.all([
    prisma.session.findMany({
      where: { playerId, storeId },
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
    }),
    prisma.purchase.findMany({
      where: { playerId, storeId },
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
    }),
    prisma.qrPayment.findMany({
      where: { playerId, storeId, isUsed: true },
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
    }),
  ]);

  const allActivity = [
    ...sessions.map(s => ({
      id: s.id,
      type: 'session',
      title: `GAME SESSION`,
      earned: s.pointsEarned,
      spent: s.paidWithPoints,
      date: s.createdAt,
    })),
    ...purchases.map(p => ({
      id: p.id,
      type: 'purchase',
      title: `SHOP: ${p.productName.toUpperCase()}`,
      earned: 0,
      spent: p.pointsSpent,
      date: p.createdAt,
    })),
    ...qrPayments.map(q => ({
      id: q.id,
      type: 'qr',
      title: `SCAN PAYMENT`,
      earned: 0,
      spent: q.pointsToDeduct,
      date: q.createdAt,
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const paginated = allActivity.slice(skip, skip + limit);
  const hasMore = allActivity.length > (skip + limit);

  res.json({
    data: paginated,
    hasMore,
    page,
    limit
  });
}));

// POST /api/player/tier-upgrade - player chooses to upgrade tier
playerRouter.post('/tier-upgrade', handleAsync(async (req: Request, res: Response) => {
  const { storeId } = z.object({ storeId: z.string().min(1) }).parse(req.body);
  const playerId = req.user!.id;

  const link = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } },
    include: { store: { include: { tierConfig: true } } },
  });
  if (!link) throw new AppError(404, 'Not enrolled in this store');
  if (!link.pendingUpgrade) throw new AppError(400, 'No tier upgrade available');
  if (link.tier >= 5) throw new AppError(400, 'Already at maximum tier');
  if (!link.store.tierConfig) throw new AppError(500, 'Tier config missing');

  // Determine points to deduct (the threshold of the NEXT tier)
  let pointsToDeduct = 0;
  const tc = link.store.tierConfig;
  const nextTier = link.tier + 1;
  
  if (nextTier === 2) pointsToDeduct = tc.tier2Threshold;
  else if (nextTier === 3) pointsToDeduct = tc.tier3Threshold;
  else if (nextTier === 4) pointsToDeduct = tc.tier4Threshold;
  else if (nextTier === 5) pointsToDeduct = tc.tier5Threshold;

  if (link.totalPoints < pointsToDeduct) {
    throw new AppError(400, `Insufficient points for ${nextTier} upgrade. Need ${pointsToDeduct} pts.`);
  }

  const updated = await prisma.playerStore.update({
    where: { playerId_storeId: { playerId, storeId } },
    data: { 
      tier: nextTier, 
      pendingUpgrade: false,
      totalPoints: { decrement: pointsToDeduct }
    },
  });

  res.json({ 
    newTier: updated.tier, 
    totalPoints: updated.totalPoints,
    deducted: pointsToDeduct 
  });
}));

// POST /api/player/qr-confirm - player scans QR and confirms payment
playerRouter.post('/qr-confirm', handleAsync(async (req: Request, res: Response) => {
  const { token } = z.object({ token: z.string().min(1) }).parse(req.body);
  const playerId = req.user!.id;

  const qr = await prisma.qrPayment.findUnique({ where: { token } });
  if (!qr) throw new AppError(404, 'Invalid QR code');
  if (qr.playerId !== playerId) throw new AppError(403, 'This QR code is not for you');
  if (qr.isUsed) throw new AppError(400, 'QR code already used');
  if (new Date() > qr.expiresAt) throw new AppError(400, 'QR code has expired');

  const link = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId: qr.storeId } },
  });
  if (!link || link.totalPoints < qr.pointsToDeduct) {
    throw new AppError(400, 'Insufficient points');
  }

  // Deduct points and mark QR as used atomically
  const [updatedLink] = await prisma.$transaction([
    prisma.playerStore.update({
      where: { playerId_storeId: { playerId, storeId: qr.storeId } },
      data: { totalPoints: { decrement: qr.pointsToDeduct } },
    }),
    prisma.qrPayment.update({
      where: { token },
      data: { isUsed: true },
    }),
  ]);

  res.json({
    success: true,
    pointsDeducted: qr.pointsToDeduct,
    remainingPoints: updatedLink.totalPoints,
  });
}));

// GET /api/player/game-stats/:storeId - chart data
playerRouter.get('/game-stats/:storeId', handleAsync(async (req: Request, res: Response) => {
  const storeId = String(req.params.storeId);
  const playerId = req.user!.id;

  const items = await prisma.sessionItem.findMany({
    where: { session: { playerId, storeId: String(storeId) } },
    include: { gameType: { select: { name: true } } },
  });

  const byGame: Record<string, { name: string; sessions: number; totalSpent: number }> = {};
  items.forEach((item: { gameType: { name: string }; subtotal: number }) => {
    const name = item.gameType.name;
    if (!byGame[name]) byGame[name] = { name, sessions: 0, totalSpent: 0 };
    byGame[name].sessions += 1;
    byGame[name].totalSpent += item.subtotal;
  });

  res.json(Object.values(byGame).sort((a, b) => b.sessions - a.sessions));
}));

// ─────────────────────────────────────────────
// SHOP API
// ─────────────────────────────────────────────

playerRouter.get('/products/:storeId', handleAsync(async (req: Request, res: Response) => {
  const storeId = String(req.params.storeId);
  const products = await prisma.product.findMany({
    where: { storeId, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(products);
}));

const purchaseSchema = z.object({
  storeId: z.string().min(1),
  productId: z.string().min(1),
});

playerRouter.post('/purchase', handleAsync(async (req: Request, res: Response) => {
  const { storeId, productId } = purchaseSchema.parse(req.body);
  const playerId = req.user!.id;

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.isActive) {
    throw new AppError(404, 'Product not found or currently unavailable');
  }

  const link = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } },
  });
  
  if (!link) throw new AppError(404, 'Not enrolled in this store');
  if (link.totalPoints < product.priceInPoints) {
    throw new AppError(400, 'Insufficient points to purchase this item');
  }

  // Deduct points and create purchase record in a transaction
  const [updatedLink, purchase] = await prisma.$transaction([
    prisma.playerStore.update({
      where: { playerId_storeId: { playerId, storeId } },
      data: { totalPoints: { decrement: product.priceInPoints } },
    }),
    prisma.purchase.create({
      data: {
        playerId,
        storeId,
        productName: product.name,
        pointsSpent: product.priceInPoints,
      }
    })
  ]);
  
  res.json({
    success: true,
    pointsDeducted: product.priceInPoints,
    remainingPoints: updatedLink.totalPoints,
    purchasedItem: product.name,
    purchaseId: purchase.id
  });
}));

// ─────────────────────────────────────────────
// TOURNAMENTS
// ─────────────────────────────────────────────

playerRouter.get('/tournaments/:storeId', handleAsync(async (req: Request, res: Response) => {
  const storeId = String(req.params.storeId);
  const playerId = req.user!.id;

  const tournaments = await prisma.tournament.findMany({
    where: { storeId, isActive: true },
    include: {
      participants: {
        where: { playerId },
      },
    },
    orderBy: { date: 'asc' },
  });

  // Attach registration state
  const data = tournaments.map(t => {
    const participant = t.participants[0];
    return {
      ...t,
      participants: undefined, // remove array
      registrationStatus: participant ? participant.status : 'unregistered'
    };
  });

  res.json(data);
}));

const registerTournamentSchema = z.object({
  storeId: z.string().min(1),
  tournamentId: z.string().min(1),
});

playerRouter.post('/tournaments/register', handleAsync(async (req: Request, res: Response) => {
  const { storeId, tournamentId } = registerTournamentSchema.parse(req.body);
  const playerId = req.user!.id;

  const link = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } },
  });
  if (!link) throw new AppError(404, 'Not enrolled in this store');

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, storeId }
  });

  if (!tournament) throw new AppError(404, 'Tournament not found');
  if (tournament.status !== 'open') throw new AppError(400, 'Tournament is not open for registration');

  const parsedMax = tournament.maxPlayers;
  if (parsedMax > 0 && tournament.registeredPlayers >= parsedMax) {
    throw new AppError(400, 'Tournament is full');
  }

  // Idempotently create player registration (if exists, ignore/error)
  const existing = await prisma.tournamentParticipant.findUnique({
    where: { tournamentId_playerId: { tournamentId, playerId } }
  });

  if (existing) {
    throw new AppError(400, `You are already registered with status: ${existing.status}`);
  }

  const participant = await prisma.tournamentParticipant.create({
    data: {
      tournamentId,
      playerId,
      status: 'pending'
    }
  });

  res.status(201).json(participant);
}));

// POST /api/player/push-token - register device push token
playerRouter.post('/push-token', handleAsync(async (req: Request, res: Response) => {
  const { token } = z.object({ token: z.string().min(1) }).parse(req.body);
  const playerId = req.user!.id;

  const deviceToken = await prisma.deviceToken.upsert({
    where: { token },
    update: { playerId },
    create: { token, playerId }
  });

  res.json({ success: true, deviceToken });
}));

// PUT /api/player/profile - update display name or phone
playerRouter.put('/profile', handleAsync(async (req: Request, res: Response) => {
  const { name, phone, avatarSeed, avatarUrl } = z.object({
    name: z.string().min(2).optional(),
    phone: z.string().optional(),
    avatarSeed: z.string().optional(),
    avatarUrl: z.string().optional(),
  }).parse(req.body);
  
  const updated = await prisma.player.update({
    where: { id: req.user!.id },
    data: { name, phone, avatarSeed, avatarUrl },
  });
  
  res.json({ 
    user: { 
      id: updated.id, 
      username: updated.username, 
      name: updated.name, 
      phone: updated.phone, 
      avatarSeed: updated.avatarSeed,
      avatarUrl: updated.avatarUrl,
      role: 'player' 
    } 
  });
}));

// PUT /api/player/reset-password
playerRouter.put('/reset-password', handleAsync(async (req: Request, res: Response) => {
  const { oldPassword, newPassword } = z.object({
    oldPassword: z.string().min(1),
    newPassword: z.string().min(6),
  }).parse(req.body);

  const player = await prisma.player.findUnique({ where: { id: req.user!.id } });
  if (!player) throw new AppError(404, 'Player not found');

  const valid = await bcrypt.compare(oldPassword, player.passwordHash);
  if (!valid) throw new AppError(401, 'Invalid old password');

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.player.update({
    where: { id: player.id },
    data: { passwordHash },
  });

  res.json({ success: true });
}));

// DELETE /api/player/profile - delete account
playerRouter.delete('/profile', handleAsync(async (req: Request, res: Response) => {
  const playerId = req.user!.id;

  // Prisma will handle cascades if configured, but let's be safe
  await prisma.$transaction([
    prisma.playerStore.deleteMany({ where: { playerId } }),
    prisma.session.deleteMany({ where: { playerId } }),
    prisma.purchase.deleteMany({ where: { playerId } }),
    prisma.deviceToken.deleteMany({ where: { playerId } }),
    prisma.tournamentParticipant.deleteMany({ where: { playerId } }),
    prisma.player.delete({ where: { id: playerId } }),
  ]);

  res.json({ success: true });
}));
