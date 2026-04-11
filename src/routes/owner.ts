import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { addMinutes } from 'date-fns';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { handleAsync, AppError } from '../middleware/errorHandler';
import {
  calculatePointsEarned,
  checkPendingUpgrade,
} from '../services/tier.service';

export const ownerRouter = Router();
ownerRouter.use(requireAuth, requireRole('owner'));

// ─────────────────────────────────────────────
// GAME TYPES
// ─────────────────────────────────────────────

const gameTypeSchema = z.object({
  name: z.string().min(1),
  pricingMode: z.enum(['hourly', 'per_game']),
  pricePerUnit: z.number().positive(),
});

ownerRouter.get('/games', handleAsync(async (req: Request, res: Response) => {
  const games = await prisma.gameType.findMany({
    where: { storeId: req.user!.storeId!, isActive: true },
    orderBy: { name: 'asc' },
  });
  res.json(games);
}));

ownerRouter.post('/games', handleAsync(async (req: Request, res: Response) => {
  const data = gameTypeSchema.parse(req.body);
  const game = await prisma.gameType.create({
    data: { ...data, storeId: req.user!.storeId! },
  });
  res.status(201).json(game);
}));

ownerRouter.put('/games/:id', handleAsync(async (req: Request, res: Response) => {
  const data = gameTypeSchema.partial().parse(req.body);
  const game = await prisma.gameType.update({
    where: { id: String(req.params.id) },
    data,
  });
  res.json(game);
}));

ownerRouter.delete('/games/:id', handleAsync(async (req: Request, res: Response) => {
  await prisma.gameType.update({
    where: { id: String(req.params.id) },
    data: { isActive: false },
  });
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// PLAYERS
// ─────────────────────────────────────────────

const createPlayerSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  name: z.string().min(2),
  phone: z.string().optional(),
});

ownerRouter.get('/players', handleAsync(async (req: Request, res: Response) => {
  const players = await prisma.playerStore.findMany({
    where: { storeId: req.user!.storeId! },
    include: {
      player: { select: { id: true, username: true, name: true, phone: true } },
    },
    orderBy: { joinedAt: 'desc' },
  });
  res.json(players);
}));

ownerRouter.post('/players', handleAsync(async (req: Request, res: Response) => {
  const { username, password, name, phone } = createPlayerSchema.parse(req.body);
  const storeId = req.user!.storeId!;

  // Check if username already exists
  const existing = await prisma.player.findUnique({ where: { username } });

  const passwordHash = await bcrypt.hash(password, 10);

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let player = existing;
    if (!player) {
      player = await tx.player.create({
        data: { username, passwordHash, name, phone },
      });
    }

    // Check if already linked to this store
    const alreadyLinked = await tx.playerStore.findUnique({
      where: { playerId_storeId: { playerId: player.id, storeId } },
    });
    if (alreadyLinked) throw new AppError(409, 'Player already linked to this store');

    const link = await tx.playerStore.create({
      data: { playerId: player.id, storeId, tier: 1, totalPoints: 0 },
    });
    return { player, link };
  });

  res.status(201).json(result);
}));

ownerRouter.get('/players/:id', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const link = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId: String(req.params.id), storeId } },
    include: {
      player: { select: { id: true, username: true, name: true, phone: true } },
    },
  });
  if (!link) throw new AppError(404, 'Player not found in this store');

  const sessions = await prisma.session.findMany({
    where: { playerId: String(req.params.id), storeId },
    include: { items: { include: { gameType: true } } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  res.json({ ...link, sessions });
}));

const updatePlayerSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional(),
  password: z.string().min(6).optional(),
});

ownerRouter.put('/players/:id', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const playerId = String(req.params.id);

  const link = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } },
  });
  if (!link) throw new AppError(404, 'Player not found in this store');

  const { name, phone, password } = updatePlayerSchema.parse(req.body);
  const updateData: any = {};
  if (name !== undefined) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (password !== undefined) updateData.passwordHash = await bcrypt.hash(password, 10);

  const player = await prisma.player.update({
    where: { id: playerId },
    data: updateData,
    select: { id: true, username: true, name: true, phone: true },
  });

  res.json({ player, link });
}));

ownerRouter.delete('/players/:id', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const playerId = String(req.params.id);

  const link = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } },
  });
  if (!link) throw new AppError(404, 'Player not found in this store');

  // Remove only the store link — player account stays for other stores
  await prisma.playerStore.delete({
    where: { playerId_storeId: { playerId, storeId } },
  });

  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// SESSIONS (BILLING)
// ─────────────────────────────────────────────

const sessionItemSchema = z.object({
  gameTypeId: z.string().min(1),
  quantity: z.number().positive(), // hours or number of games
});

const createSessionSchema = z.object({
  playerId: z.string().min(1),
  items: z.array(sessionItemSchema).min(1),
});

ownerRouter.post('/sessions', handleAsync(async (req: Request, res: Response) => {
  const { playerId, items } = createSessionSchema.parse(req.body);
  const storeId = req.user!.storeId!;

  // Verify player is linked to this store
  const playerLink = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } },
  });
  if (!playerLink) throw new AppError(404, 'Player not found in this store');

  // Get tier config
  const tierConfig = await prisma.tierConfig.findUnique({ where: { storeId } });
  if (!tierConfig) throw new AppError(500, 'Store tier config not found');

  // Get all game types for price calculation
  const gameTypeIds = items.map((i) => i.gameTypeId);
  const gameTypes = await prisma.gameType.findMany({
    where: { id: { in: gameTypeIds }, storeId, isActive: true },
  });

  if (gameTypes.length !== gameTypeIds.length) {
    throw new AppError(400, 'One or more game types not found or inactive');
  }

  // Calculate subtotals
  const sessionItems = items.map((item: { gameTypeId: string; quantity: number }) => {
    const gameType = gameTypes.find((g: { id: string }) => g.id === item.gameTypeId)!;
    const subtotal = +(gameType.pricePerUnit * item.quantity).toFixed(3);
    return { gameTypeId: item.gameTypeId, quantity: item.quantity, subtotal };
  });

  const totalAmount = +sessionItems.reduce((sum, i) => sum + i.subtotal, 0).toFixed(3);
  const pointsEarned = calculatePointsEarned(totalAmount, playerLink.tier, tierConfig);
  const newTotalPoints = playerLink.totalPoints + pointsEarned;
  const pendingUpgrade = checkPendingUpgrade(newTotalPoints, playerLink.tier, tierConfig);

  // Persist everything in a transaction
  const session = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const s = await tx.session.create({
      data: {
        storeId,
        playerId,
        totalAmount,
        pointsEarned,
        isPaid: true,
        items: {
          create: sessionItems,
        },
      },
      include: { items: { include: { gameType: true } } },
    });

    await tx.playerStore.update({
      where: { playerId_storeId: { playerId, storeId } },
      data: { totalPoints: newTotalPoints, pendingUpgrade },
    });

    return s;
  });

  res.status(201).json({ session, newTotalPoints, pointsEarned, pendingUpgrade });
}));

ownerRouter.get('/sessions', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const { date } = req.query;

  const where: any = { storeId };
  if (date) {
    const day = new Date(date as string);
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);
    where.createdAt = { gte: day, lt: nextDay };
  }

  const sessions = await prisma.session.findMany({
    where,
    include: {
      player: { select: { id: true, name: true, username: true } },
      items: { include: { gameType: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(sessions);
}));

ownerRouter.get('/sessions/:id', handleAsync(async (req: Request, res: Response) => {
  const session = await prisma.session.findFirst({
    where: { id: String(req.params.id), storeId: req.user!.storeId! },
    include: {
      player: { select: { id: true, name: true, username: true } },
      items: { include: { gameType: true } },
    },
  });
  if (!session) throw new AppError(404, 'Session not found');
  res.json(session);
}));

// ─────────────────────────────────────────────
// QR PAYMENT GENERATION
// ─────────────────────────────────────────────

const generateQrSchema = z.object({
  playerId: z.string().min(1),
  pointsToDeduct: z.number().int().positive(),
});

ownerRouter.post('/qr-payment', handleAsync(async (req: Request, res: Response) => {
  const { playerId, pointsToDeduct } = generateQrSchema.parse(req.body);
  const storeId = req.user!.storeId!;

  // Verify player has enough points
  const playerLink = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } },
  });
  if (!playerLink) throw new AppError(404, 'Player not found in this store');
  if (playerLink.totalPoints < pointsToDeduct) {
    throw new AppError(400, `Player only has ${playerLink.totalPoints} points`);
  }

  // Expire any previous unused QR for this player/store
  await prisma.qrPayment.updateMany({
    where: { playerId, storeId, isUsed: false },
    data: { isUsed: true },
  });

  const qrPayment = await prisma.qrPayment.create({
    data: {
      playerId,
      storeId,
      pointsToDeduct,
      token: randomUUID(),
      expiresAt: addMinutes(new Date(), 5),
    },
  });

  res.status(201).json({ token: qrPayment.token, expiresAt: qrPayment.expiresAt, pointsToDeduct });
}));

// Poll status (owner side waiting for player to scan)
ownerRouter.get('/qr-payment/:token/status', handleAsync(async (req: Request, res: Response) => {
  const qr = await prisma.qrPayment.findUnique({ where: { token: String(req.params.token) } });
  if (!qr) throw new AppError(404, 'QR token not found');
  const expired = new Date() > qr.expiresAt && !qr.isUsed;
  res.json({ isUsed: qr.isUsed, expired, expiresAt: qr.expiresAt });
}));

// ─────────────────────────────────────────────
// TIER CONFIG
// ─────────────────────────────────────────────

const tierConfigSchema = z.object({
  tier1Threshold: z.number().int().min(0).optional(),
  tier2Threshold: z.number().int().positive().optional(),
  tier3Threshold: z.number().int().positive().optional(),
  tier4Threshold: z.number().int().positive().optional(),
  tier5Threshold: z.number().int().positive().optional(),
  tier1Pct: z.number().min(0).max(100).optional(),
  tier2Pct: z.number().min(0).max(100).optional(),
  tier3Pct: z.number().min(0).max(100).optional(),
  tier4Pct: z.number().min(0).max(100).optional(),
  tier5Pct: z.number().min(0).max(100).optional(),
  pointsPerDt: z.number().int().positive().optional(),
});

ownerRouter.get('/tier-config', handleAsync(async (req: Request, res: Response) => {
  const config = await prisma.tierConfig.findUnique({ where: { storeId: req.user!.storeId! } });
  if (!config) throw new AppError(404, 'Tier config not found');
  res.json(config);
}));

ownerRouter.put('/tier-config', handleAsync(async (req: Request, res: Response) => {
  const data = tierConfigSchema.parse(req.body);
  const config = await prisma.tierConfig.update({
    where: { storeId: req.user!.storeId! },
    data,
  });
  res.json(config);
}));

// ─────────────────────────────────────────────
// PRODUCTS (SHOP)
// ─────────────────────────────────────────────

const productSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  priceInPoints: z.number().int().positive(),
  imageUrl: z.string().optional(),
});

ownerRouter.get('/products', handleAsync(async (req: Request, res: Response) => {
  const products = await prisma.product.findMany({
    where: { storeId: req.user!.storeId! },
    orderBy: { createdAt: 'desc' },
  });
  res.json(products);
}));

ownerRouter.post('/products', handleAsync(async (req: Request, res: Response) => {
  const data = productSchema.parse(req.body);
  const product = await prisma.product.create({
    data: { ...data, storeId: req.user!.storeId! },
  });
  res.status(201).json(product);
}));

ownerRouter.put('/products/:id', handleAsync(async (req: Request, res: Response) => {
  const data = productSchema.partial().parse(req.body);
  const product = await prisma.product.update({
    where: { id: String(req.params.id) },
    data,
  });
  res.json(product);
}));

ownerRouter.delete('/products/:id', handleAsync(async (req: Request, res: Response) => {
  await prisma.product.delete({
    where: { id: String(req.params.id) },
  });
  res.json({ success: true });
}));

ownerRouter.patch('/products/:id/toggle', handleAsync(async (req: Request, res: Response) => {
  const current = await prisma.product.findUnique({ where: { id: String(req.params.id) } });
  if (!current) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  
  const product = await prisma.product.update({
    where: { id: String(req.params.id) },
    data: { isActive: !current.isActive },
  });
  res.json(product);
}));

// ─────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────

ownerRouter.get('/reports/daily', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const sessions = await prisma.session.findMany({
    where: { storeId, createdAt: { gte: today, lt: tomorrow } },
    include: { items: { include: { gameType: { select: { name: true } } } } },
  });

  const totalRevenue = sessions.reduce((sum: number, s: { totalAmount: number }) => sum + s.totalAmount, 0);
  const sessionCount = sessions.length;

  // Game popularity
  const gameCounts: Record<string, { name: string; count: number; revenue: number }> = {};
  sessions.forEach((s: { items: Array<{ gameType: { name: string }; subtotal: number }> }) => {
    s.items.forEach((item: { gameType: { name: string }; subtotal: number }) => {
      const name = item.gameType.name;
      if (!gameCounts[name]) gameCounts[name] = { name, count: 0, revenue: 0 };
      gameCounts[name].count += 1;
      gameCounts[name].revenue += item.subtotal;
    });
  });

  res.json({
    date: today.toISOString().split('T')[0],
    totalRevenue: +totalRevenue.toFixed(3),
    sessionCount,
    topGames: Object.values(gameCounts).sort((a, b) => b.count - a.count),
  });
}));

ownerRouter.get('/reports/monthly', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const sessions = await prisma.session.findMany({
    where: { storeId, createdAt: { gte: firstOfMonth } },
    include: { items: { include: { gameType: { select: { name: true } } } } },
  });

  // Group by day
  const byDay: Record<string, number> = {};
  sessions.forEach((s: any) => {
    const day = s.createdAt.toISOString().split('T')[0];
    byDay[day] = (byDay[day] || 0) + s.totalAmount;
  });

  const totalRevenue = sessions.reduce((sum: number, s: any) => sum + s.totalAmount, 0);

  // Game popularity for the month
  const gameCounts: Record<string, { name: string; count: number; revenue: number }> = {};
  sessions.forEach((s: any) => {
    s.items.forEach((item: any) => {
      const name = item.gameType.name;
      if (!gameCounts[name]) gameCounts[name] = { name, count: 0, revenue: 0 };
      gameCounts[name].count += 1;
      gameCounts[name].revenue += item.subtotal;
    });
  });
  res.json({
    month: firstOfMonth.toISOString().split('T')[0].slice(0, 7),
    totalRevenue: +totalRevenue.toFixed(3),
    sessionCount: sessions.length,
    topGames: Object.values(gameCounts).sort((a, b) => b.revenue - a.revenue),
    dailyBreakdown: Object.entries(byDay)
      .map(([date, revenue]) => ({ date, revenue: +revenue.toFixed(3) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  });
}));

// ─────────────────────────────────────────────
// TOURNAMENTS
// ─────────────────────────────────────────────

const tournamentSchema = z.object({
  name: z.string().min(1),
  date: z.string().or(z.date()), // accepts ISO string
  prizePool: z.string().min(1),
  entryPrice: z.string().optional(),
  maxPlayers: z.number().int().positive(),
  status: z.enum(['open', 'coming_soon', 'completed']).optional(),
  imageUrl: z.string().optional(),
});

ownerRouter.get('/tournaments', handleAsync(async (req: Request, res: Response) => {
  const tournaments = await prisma.tournament.findMany({
    where: { storeId: req.user!.storeId! },
    include: {
      participants: {
        include: {
          player: { select: { id: true, username: true, name: true } },
        },
      },
    },
    orderBy: { date: 'asc' },
  });
  
  res.json(tournaments);
}));

ownerRouter.post('/tournaments', handleAsync(async (req: Request, res: Response) => {
  const data = tournamentSchema.parse(req.body);
  const tournament = await prisma.tournament.create({
    data: {
      ...data,
      date: new Date(data.date),
      storeId: req.user!.storeId!,
    },
  });
  res.status(201).json(tournament);
}));

ownerRouter.put('/tournaments/:id', handleAsync(async (req: Request, res: Response) => {
  const data = tournamentSchema.partial().parse(req.body);
  const updateData: any = { ...data };
  if (data.date) updateData.date = new Date(data.date);
  
  const tournament = await prisma.tournament.update({
    where: { id: String(req.params.id), storeId: req.user!.storeId! },
    data: updateData,
  });
  res.json(tournament);
}));

ownerRouter.delete('/tournaments/:id', handleAsync(async (req: Request, res: Response) => {
  await prisma.tournament.delete({
    where: { id: String(req.params.id), storeId: req.user!.storeId! },
  });
  res.json({ success: true });
}));

ownerRouter.patch('/tournaments/:id/toggle', handleAsync(async (req: Request, res: Response) => {
  const current = await prisma.tournament.findUnique({ where: { id: String(req.params.id) } });
  if (!current) {
    res.status(404).json({ error: 'Tournament not found' });
    return;
  }
  const tournament = await prisma.tournament.update({
    where: { id: String(req.params.id) },
    data: { isActive: !current.isActive },
  });
  res.json(tournament);
}));

// ─────────────────────────────────────────────
// TOURNAMENT PARTICIPANTS (APPROVAL/REJECTION)
// ─────────────────────────────────────────────

ownerRouter.put('/tournaments/:id/participants/:playerId', handleAsync(async (req: Request, res: Response) => {
  const { status } = z.object({
    status: z.enum(['pending', 'accepted', 'rejected'])
  }).parse(req.body);
  
  const tournamentId = String(req.params.id);
  const playerId = String(req.params.playerId);
  const storeId = req.user!.storeId!;
  
  // Verify tournament belongs to owner
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, storeId }
  });
  
  if (!tournament) throw new AppError(404, 'Tournament not found');

  const participant = await prisma.tournamentParticipant.update({
    where: {
      tournamentId_playerId: { tournamentId, playerId }
    },
    data: { status }
  });
  
  // If status changed to accepted, we might want to update registeredPlayers count.
  // Actually, we can count the accepted ones dynamically or increment/decrement here.
  // For safety, let's recount all accepted participants and update the tournament
  const acceptedCount = await prisma.tournamentParticipant.count({
    where: { tournamentId, status: 'accepted' }
  });
  
  await prisma.tournament.update({
    where: { id: tournamentId },
    data: { registeredPlayers: acceptedCount }
  });

  res.json({ participant, registeredPlayers: acceptedCount });
}));


