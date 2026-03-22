import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { handleAsync, AppError } from '../middleware/errorHandler';
import { z } from 'zod';

export const playerRouter = Router();
playerRouter.use(requireAuth, requireRole('player'));

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
  if (link.tier >= 3) throw new AppError(400, 'Already at maximum tier');

  const updated = await prisma.playerStore.update({
    where: { playerId_storeId: { playerId, storeId } },
    data: { tier: link.tier + 1, pendingUpgrade: false },
  });

  res.json({ newTier: updated.tier, totalPoints: updated.totalPoints });
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
