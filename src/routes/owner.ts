import { Router, Request, Response } from 'express';
import { Expo } from 'expo-server-sdk';
import bcrypt from 'bcryptjs';
import { sendPushNotification, sendPushNotificationToMultiple } from '../services/notification.service';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { addMinutes } from 'date-fns';
import { Prisma } from '@prisma/client';
// Dynamic import used below for ESM compatibility
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
// SCAN PLAYER (owner scans player's identity QR)
// ─────────────────────────────────────────────

ownerRouter.get('/scan-player/:playerId', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const playerId = String(req.params.playerId);

  const player = await prisma.player.findFirst({
    where: {
      OR: [
        { id: playerId },
        { username: { equals: playerId, mode: 'insensitive' } },
        { phone: playerId },
      ],
    },
    select: { id: true, username: true, name: true, phone: true },
  });
  if (!player) throw new AppError(404, 'Player not found');

  // Get store-specific points/tier — may not exist yet (first visit)
  const link = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId: player.id, storeId } },
  });

  // Check for pending cash shop orders
  const pendingOrder = await prisma.pendingCashOrder.findFirst({
    where: { storeId, playerId: player.id, status: 'pending' },
    include: { product: true },
    orderBy: { createdAt: 'desc' }
  });

  res.json({
    player,
    totalPoints: link?.totalPoints ?? 0,
    tier: link?.tier ?? 1,
    isFirstVisit: !link,
    pendingOrder
  });
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
  pointsToDeduct: z.number().int().nonnegative().optional(), // direct deduction, no QR needed
});

ownerRouter.post('/sessions', handleAsync(async (req: Request, res: Response) => {
  const { playerId, items, pointsToDeduct = 0 } = createSessionSchema.parse(req.body);
  const storeId = req.user!.storeId!;

  // Verify player exists
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) throw new AppError(404, 'Player not found');

  // Get tier config
  const tierConfig = await prisma.tierConfig.findUnique({ where: { storeId } });
  if (!tierConfig) throw new AppError(500, 'Store tier config not found');

  // Auto-create PlayerStore link on first visit (no explicit join needed)
  let playerLink = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } },
  });
  if (!playerLink) {
    playerLink = await prisma.playerStore.create({
      data: { playerId, storeId, tier: 1, totalPoints: 0 },
    });
  }

  // Validate point deduction
  if (pointsToDeduct > 0 && playerLink.totalPoints < pointsToDeduct) {
    throw new AppError(400, `Insufficient points. Player has ${playerLink.totalPoints} pts, requested ${pointsToDeduct}`);
  }

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
  const newTotalPoints = playerLink.totalPoints + pointsEarned - pointsToDeduct;
  const pendingUpgrade = checkPendingUpgrade(newTotalPoints, playerLink.tier, tierConfig);

  // Persist everything in a transaction
  const session = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const s = await tx.session.create({
      data: {
        storeId,
        playerId,
        totalAmount,
        pointsEarned,
        paidWithPoints: pointsToDeduct,
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

  res.status(201).json({ session, newTotalPoints, pointsEarned, pointsDeducted: pointsToDeduct, pendingUpgrade });
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
  shopCashbackPct: z.number().min(0).max(100).optional(),
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

  // Recalculate pendingUpgrade for all player links in this store under the new config
  const playerLinks = await prisma.playerStore.findMany({
    where: { storeId: req.user!.storeId! }
  });
  for (const link of playerLinks) {
    const isEligible = checkPendingUpgrade(link.totalPoints, link.tier, config);
    if (link.pendingUpgrade !== isEligible) {
      await prisma.playerStore.update({
        where: { id: link.id },
        data: { pendingUpgrade: isEligible }
      });
    }
  }

  res.json(config);
}));


// ─────────────────────────────────────────────
// PRODUCTS (SHOP)
// ─────────────────────────────────────────────

const productSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  priceInPoints: z.number().int().positive(),
  priceInDt: z.number().positive().optional().nullable(),
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
// PENDING CASH ORDERS (SHOP)
// ─────────────────────────────────────────────

ownerRouter.get('/shop/pending-order/:playerId', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const playerId = String(req.params.playerId);

  const pendingOrder = await prisma.pendingCashOrder.findFirst({
    where: {
      storeId,
      playerId,
      status: 'pending'
    },
    include: {
      player: { select: { name: true, username: true } },
      product: { select: { name: true } }
    },
    orderBy: { createdAt: 'desc' }
  });

  res.json(pendingOrder);
}));

ownerRouter.post('/shop/confirm-cash-payment', handleAsync(async (req: Request, res: Response) => {
  const { pendingOrderId } = z.object({
    pendingOrderId: z.string().uuid()
  }).parse(req.body);
  const storeId = req.user!.storeId!;

  const pendingOrder = await prisma.pendingCashOrder.findFirst({
    where: { id: pendingOrderId, storeId, status: 'pending' },
    include: { product: true }
  });

  if (!pendingOrder) {
    throw new AppError(404, 'Pending order not found or already completed');
  }

  // Transaction to complete order, give points, and log purchase
  const result = await prisma.$transaction(async (tx) => {
    // 1. Mark as completed
    const order = await tx.pendingCashOrder.update({
      where: { id: pendingOrderId },
      data: { status: 'completed' }
    });

    // 2. Add points to player link
    const playerLink = await tx.playerStore.findUnique({
      where: { playerId_storeId: { playerId: order.playerId, storeId } }
    });

    if (playerLink) {
      await tx.playerStore.update({
        where: { id: playerLink.id },
        data: { totalPoints: { increment: order.pointsToEarn } }
      });
    } else {
      await tx.playerStore.create({
        data: {
          playerId: order.playerId,
          storeId,
          totalPoints: order.pointsToEarn,
          tier: 1
        }
      });
    }

    // 3. Log purchase
    await tx.purchase.create({
      data: {
        storeId,
        playerId: order.playerId,
        productName: pendingOrder.product.name,
        pointsSpent: 0,
        cashSpent: order.amountDt,
        pointsEarned: order.pointsToEarn
      }
    });

    return order;
  });

  res.json(result);
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
  format: z.enum(['single_elimination', 'group_knockout', 'group_points']).optional(),
  groupSize: z.number().int().positive().nullable().optional(),
  advancingCount: z.number().int().positive().nullable().optional(),
  schedulingRange: z.number().int().min(1).max(90).optional(),
});

ownerRouter.get('/tournaments', handleAsync(async (req: Request, res: Response) => {
  const tournaments = await prisma.tournament.findMany({
    where: { storeId: req.user!.storeId! },
    include: {
      participants: {
        include: {
          player: { select: { id: true, username: true, name: true, avatarUrl: true, avatarSeed: true } },
        },
      },
    },
    orderBy: { date: 'asc' },
  });
  
  res.json(tournaments);
}));

ownerRouter.post('/tournaments', handleAsync(async (req: Request, res: Response) => {
  const data = tournamentSchema.parse(req.body);
  const storeId = req.user!.storeId!;

  const tournament = await prisma.tournament.create({
    data: {
      ...data,
      date: new Date(data.date),
      storeId,
    },
  });

  // Draft dynamic themed announcement
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  
  let title = `🏆 New Tournament in ${store?.name || 'NEO'}`;
  let body = `Join the new tournament: ${tournament.name}! Prize Pool: ${tournament.prizePool}.`;

  const cleanDate = new Date(tournament.date).toLocaleString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });

  const entryText = tournament.entryPrice && tournament.entryPrice.toLowerCase() !== 'gratuit'
    ? `Entry: ${tournament.entryPrice}`
    : 'Entry: FREE';

  const limitText = tournament.maxPlayers > 0 ? `Only ${tournament.maxPlayers} slots available!` : '';

  if (tournament.format === 'single_elimination') {
    title = `⚔️ SUDDEN DEATH: ${tournament.name}`;
    body = `New Single Elimination tournament at ${store?.name || 'NEO'}! Lose once and you are out. Prize: ${tournament.prizePool}. ${entryText}. ${limitText} Starts ${cleanDate}!`;
  } else if (tournament.format === 'group_knockout') {
    title = `🔥 SURVIVE GROUPS: ${tournament.name}`;
    body = `New Group Knockout tournament at ${store?.name || 'NEO'}! Face your group, qualify for the finals. Prize: ${tournament.prizePool}. ${entryText}. ${limitText} Starts ${cleanDate}!`;
  } else if (tournament.format === 'group_points') {
    title = `📈 LEADERBOARD RUN: ${tournament.name}`;
    body = `New Group Points tournament at ${store?.name || 'NEO'}! Every match scores points, climb the standings. Prize: ${tournament.prizePool}. ${entryText}. ${limitText} Starts ${cleanDate}!`;
  }

  // Save to notifications history
  await prisma.notification.create({
    data: {
      storeId,
      title,
      body,
    }
  });

  // Fetch all players for this store
  const playerLinks = await prisma.playerStore.findMany({
    where: { storeId },
    select: { playerId: true }
  });
  const playerIds = playerLinks.map(l => l.playerId);

  if (playerIds.length > 0) {
    await sendPushNotificationToMultiple(playerIds, title, body, {
      type: 'tournament_created',
      tournamentId: tournament.id
    });
  }

  res.status(201).json(tournament);
}));

ownerRouter.put('/tournaments/:id', handleAsync(async (req: Request, res: Response) => {
  const data = tournamentSchema.partial().parse(req.body);
  const updateData: any = { ...data };
  if (data.date) updateData.date = new Date(data.date);
  
  const existing = await prisma.tournament.findFirst({
    where: { id: String(req.params.id), storeId: req.user!.storeId! }
  });
  if (!existing) {
    throw new AppError(404, 'Tournament not found');
  }
  if (existing.status === 'completed' && data.status && data.status !== 'completed') {
    throw new AppError(400, 'Cannot change the status of a completed tournament');
  }

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

// ─────────────────────────────────────────────
// TOURNAMENT MATCHES & BRACKET ENGINE
// ─────────────────────────────────────────────

function getRoundRobinMatches(players: string[]) {
  const list = [...players];
  const n = list.length;
  const matches: { player1Id: string; player2Id: string; round: number }[] = [];
  if (n < 2) return matches;

  // Circle Method for even S
  const rounds = n - 1;
  const half = n / 2;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < half; i++) {
      const p1 = list[i];
      const p2 = list[n - 1 - i];
      if (p1 && p2) {
        matches.push({ player1Id: p1, player2Id: p2, round: r + 1 });
      }
    }
    // Rotate list (keep first element fixed)
    list.splice(1, 0, list.pop()!);
  }
  return matches;
}

ownerRouter.post('/tournaments/:id/start', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);
  const storeId = req.user!.storeId!;

  // ── 1. Read-only validation (no transaction needed) ──────────────────────
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, storeId }
  });
  if (!tournament) throw new AppError(404, 'Tournament not found');
  if (tournament.status === 'completed' || tournament.status === 'in_progress') {
    throw new AppError(400, 'Tournament has already started or completed');
  }

  const acceptedParticipants = await prisma.tournamentParticipant.findMany({
    where: { tournamentId, status: 'accepted' },
    orderBy: { registeredAt: 'asc' }
  });

  const playerCount = acceptedParticipants.length;
  if (playerCount < tournament.maxPlayers) {
    throw new AppError(400, `Need all ${tournament.maxPlayers} accepted players to start (currently ${playerCount})`);
  }
  if (playerCount < 2) {
    throw new AppError(400, 'Need at least 2 accepted players to start');
  }

  // ── 2. Build all match data in memory (CPU only, zero DB calls) ──────────
  const format = tournament.format || 'single_elimination';
  const shuffled = [...acceptedParticipants].sort(() => Math.random() - 0.5);
  let matchesToCreate: any[] = [];
  const participantGroupAssignments: { tournamentId: string; playerId: string; group: string }[] = [];

  if (format === 'single_elimination') {
    let bracketSize = 2;
    while (bracketSize < playerCount) bracketSize *= 2;
    const totalRounds = Math.log2(bracketSize);
    const matchesMap: Record<string, any> = {};

    for (let r = 1; r <= totalRounds; r++) {
      const matchCountInRound = bracketSize / Math.pow(2, r);
      for (let idx = 0; idx < matchCountInRound; idx++) {
        matchesMap[`${r}_${idx}`] = {
          tournamentId, round: r, matchIndex: idx, status: 'pending',
          player1Id: null, player2Id: null, winnerId: null,
          player1Score: 0, player2Score: 0,
        };
      }
    }

    const round1MatchCount = bracketSize / 2;
    for (let idx = 0; idx < round1MatchCount; idx++) {
      const match = matchesMap[`1_${idx}`];
      const p1 = idx * 2 < playerCount ? shuffled[idx * 2].playerId : null;
      const p2 = idx * 2 + 1 < playerCount ? shuffled[idx * 2 + 1].playerId : null;
      match.player1Id = p1;
      match.player2Id = p2;

      const byePlayer = (p1 && !p2) ? p1 : (!p1 && p2) ? p2 : null;
      if (byePlayer) {
        match.winnerId = byePlayer;
        match.status = 'completed';
        match.player1Score = p1 ? 1 : 0;
        match.player2Score = p2 ? 1 : 0;
        const nextMatch = matchesMap[`2_${Math.floor(idx / 2)}`];
        if (nextMatch) {
          if (idx % 2 === 0) nextMatch.player1Id = byePlayer;
          else nextMatch.player2Id = byePlayer;
        }
      }
    }
    matchesToCreate = Object.values(matchesMap);

  } else {
    // Group Formats
    const groupSize = tournament.groupSize || 4;
    const groupCount = Math.floor(playerCount / groupSize);

    for (let i = 0; i < shuffled.length; i++) {
      const groupName = String.fromCharCode(65 + Math.floor(i / groupSize));
      (shuffled[i] as any).group = groupName;
      participantGroupAssignments.push({ tournamentId, playerId: shuffled[i].playerId, group: groupName });
    }

    for (let g = 0; g < groupCount; g++) {
      const groupName = String.fromCharCode(65 + g);
      const groupPlayers = shuffled
        .filter(p => (p as any).group === groupName)
        .map(p => p.playerId);

      if (format === 'group_points') {
        const rrMatches = getRoundRobinMatches(groupPlayers);
        rrMatches.forEach((rrm, idx) => {
          matchesToCreate.push({
            tournamentId, round: rrm.round, matchIndex: idx, group: groupName,
            player1Id: rrm.player1Id, player2Id: rrm.player2Id, status: 'pending',
          });
        });
      } else if (format === 'group_knockout') {
        const totalRounds = Math.log2(groupSize);
        const groupMatchesMap: Record<string, any> = {};
        for (let r = 1; r <= totalRounds; r++) {
          const matchCountInRound = groupSize / Math.pow(2, r);
          for (let idx = 0; idx < matchCountInRound; idx++) {
            groupMatchesMap[`${r}_${idx}`] = {
              tournamentId, round: r, matchIndex: idx, group: groupName, status: 'pending',
              player1Id: null, player2Id: null, winnerId: null, player1Score: 0, player2Score: 0,
            };
          }
        }
        const round1MatchCount = groupSize / 2;
        for (let idx = 0; idx < round1MatchCount; idx++) {
          const m = groupMatchesMap[`1_${idx}`];
          m.player1Id = groupPlayers[idx * 2];
          m.player2Id = groupPlayers[idx * 2 + 1];
        }
        matchesToCreate.push(...Object.values(groupMatchesMap));
      }
    }
  }

  // ── 3. Persist sequentially (no interactive transaction — PgBouncer safe) ─
  // Mark tournament as in_progress
  await prisma.tournament.update({
    where: { id: tournamentId },
    data: { status: 'in_progress' }
  });

  // Assign groups (group formats only)
  if (participantGroupAssignments.length > 0) {
    // Group assignments by group name for batched updateMany
    const byGroup: Record<string, string[]> = {};
    for (const a of participantGroupAssignments) {
      if (!byGroup[a.group]) byGroup[a.group] = [];
      byGroup[a.group].push(a.playerId);
    }
    for (const [groupName, playerIds] of Object.entries(byGroup)) {
      await prisma.tournamentParticipant.updateMany({
        where: { tournamentId, playerId: { in: playerIds } },
        data: { group: groupName }
      });
    }
  }

  // Bulk insert all matches in one shot
  if (matchesToCreate.length > 0) {
    await prisma.match.createMany({ data: matchesToCreate });

    // Send notifications to round 1 players in background
    try {
      const round1Matches = await prisma.match.findMany({
        where: { tournamentId, round: 1 },
        include: {
          player1: { select: { id: true, name: true } },
          player2: { select: { id: true, name: true } }
        }
      });

      for (const match of round1Matches) {
        if (match.player1Id && match.player2Id) {
          const p1Name = match.player1?.name || 'Opponent';
          const p2Name = match.player2?.name || 'Opponent';

          await sendPushNotification(
            match.player1Id,
            '🎮 Match Ready - Round 1',
            `Your match against @${p2Name} is ready! Tap to coordinate the date/time or play.`,
            { type: 'match_ready', matchId: match.id }
          );

          await sendPushNotification(
            match.player2Id,
            '🎮 Match Ready - Round 1',
            `Your match against @${p1Name} is ready! Tap to coordinate the date/time or play.`,
            { type: 'match_ready', matchId: match.id }
          );
        }
      }
    } catch (err) {
      console.error('Error sending round 1 notifications:', err);
    }
  }

  res.json({ success: true });
}));

ownerRouter.get('/tournaments/:id/matches', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);
  const storeId = req.user!.storeId!;

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, storeId }
  });
  if (!tournament) throw new AppError(404, 'Tournament not found');

  const matches = await prisma.match.findMany({
    where: { tournamentId },
    include: {
      player1: { select: { id: true, name: true, username: true } },
      player2: { select: { id: true, name: true, username: true } },
    },
    orderBy: [
      { round: 'asc' },
      { matchIndex: 'asc' }
    ]
  });

  res.json(matches);
}));

async function computeStandingsInternal(tx: any, tournamentId: string) {
  const participants = await tx.tournamentParticipant.findMany({
    where: { tournamentId, status: 'accepted' },
    include: {
      player: {
        select: {
          id: true,
          name: true,
          username: true,
          avatarUrl: true,
        }
      }
    }
  });

  const matches = await tx.match.findMany({
    where: { tournamentId, group: { not: null } }
  });

  const groups: Record<string, any[]> = {};

  for (const p of participants) {
    if (!p.group) continue;
    if (!groups[p.group]) {
      groups[p.group] = [];
    }
    groups[p.group].push({
      playerId: p.playerId,
      playerName: p.player.name || p.player.username,
      avatarUrl: p.player.avatarUrl,
      played: 0,
      wins: 0,
      losses: 0,
      points: 0,
      scoresWon: 0,
      scoresConceded: 0,
      scoreDiff: 0
    });
  }

  for (const m of matches) {
    if (m.status !== 'completed' || !m.group) continue;
    const groupStandings = groups[m.group];
    if (!groupStandings) continue;

    const p1 = groupStandings.find(s => s.playerId === m.player1Id);
    const p2 = groupStandings.find(s => s.playerId === m.player2Id);

    if (p1 && p2) {
      p1.played++;
      p2.played++;
      p1.scoresWon += m.player1Score;
      p1.scoresConceded += m.player2Score;
      p2.scoresWon += m.player2Score;
      p2.scoresConceded += m.player1Score;

      if (m.winnerId === m.player1Id) {
        p1.wins++;
        p1.points += 3;
        p2.losses++;
      } else if (m.winnerId === m.player2Id) {
        p2.wins++;
        p2.points += 3;
        p1.losses++;
      }
      // No draw — every match has a definitive winner
    }
  }

  for (const groupName of Object.keys(groups)) {
    const standings = groups[groupName];
    for (const s of standings) {
      s.scoreDiff = s.scoresWon - s.scoresConceded;
    }

    standings.sort((a: any, b: any) => {
      if (b.points !== a.points) {
        return b.points - a.points;
      }

      const directMatch = matches.find(
        (m: any) => (m.player1Id === a.playerId && m.player2Id === b.playerId) ||
             (m.player1Id === b.playerId && m.player2Id === a.playerId)
      );
      if (directMatch && directMatch.status === 'completed' && directMatch.winnerId) {
        if (directMatch.winnerId === a.playerId) return -1;
        if (directMatch.winnerId === b.playerId) return 1;
      }

      if (b.scoreDiff !== a.scoreDiff) {
        return b.scoreDiff - a.scoreDiff;
      }

      if (b.scoresWon !== a.scoresWon) {
        return b.scoresWon - a.scoresWon;
      }

      return a.playerName.localeCompare(b.playerName);
    });
  }

  return groups;
}

ownerRouter.get('/tournaments/:id/standings', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);
  const storeId = req.user!.storeId!;

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, storeId }
  });
  if (!tournament) throw new AppError(404, 'Tournament not found');

  const standings = await computeStandingsInternal(prisma, tournamentId);
  res.json(standings);
}));

ownerRouter.put('/tournaments/:id/matches/:matchId/score', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);
  const matchId = String(req.params.matchId);
  const storeId = req.user!.storeId!;
  const { player1Score, player2Score } = z.object({
    player1Score: z.number().int().nonnegative(),
    player2Score: z.number().int().nonnegative(),
  }).parse(req.body);

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, storeId }
  });
  if (!tournament) throw new AppError(404, 'Tournament not found');

  const match = await prisma.match.findUnique({
    where: { id: matchId, tournamentId },
    include: {
      player1: { select: { id: true, name: true } },
      player2: { select: { id: true, name: true } }
    }
  });
  if (!match) throw new AppError(404, 'Match not found');
  if (match.status === 'completed') {
    throw new AppError(400, 'Match is already completed');
  }
  if (!match.player1Id || !match.player2Id) {
    throw new AppError(400, 'Cannot record score for match with missing players');
  }

  const winnerId = player1Score > player2Score ? match.player1Id : match.player2Id;

  // ── 1. Update match score & mark completed ──────────────────────────────
  const updatedMatch = await prisma.match.update({
    where: { id: matchId },
    data: { player1Score, player2Score, winnerId, status: 'completed' }
  });

  // Send notifications for match completed
  try {
    const p1Name = match.player1?.name || 'Player 1';
    const p2Name = match.player2?.name || 'Player 2';
    const matchCompletedTitle = '🎯 Match Result Registered';
    const matchCompletedBody = `${p1Name} vs ${p2Name} finished with score: ${player1Score} - ${player2Score}.`;
    if (match.player1Id) {
      await sendPushNotification(
        match.player1Id,
        matchCompletedTitle,
        matchCompletedBody,
        { type: 'match_completed', matchId }
      );
    }
    if (match.player2Id) {
      await sendPushNotification(
        match.player2Id,
        matchCompletedTitle,
        matchCompletedBody,
        { type: 'match_completed', matchId }
      );
    }
  } catch (err) {
    console.error('Error sending match score notifications:', err);
  }

  // ── 2. Fetch all matches for progression logic ───────────────────────────
  const allMatches = await prisma.match.findMany({ where: { tournamentId } });

  if (match.group) {
    // GROUP STAGE
    const groupSize = tournament.groupSize || 4;
    const format = tournament.format || 'group_points';

    if (format === 'group_knockout') {
      const maxGroupRound = Math.log2(groupSize);

      if (match.round === maxGroupRound) {
        // This group's mini-bracket is done — check if ALL groups are done
        const pendingGroupMatches = allMatches.filter(
          m => m.group !== null && m.status !== 'completed' && m.id !== matchId
        );

        if (pendingGroupMatches.length === 0) {
          // All groups done — build knockout bracket in memory
          const groupCount = tournament.maxPlayers / groupSize;
          const groupWinners: string[] = [];
          for (let g = 0; g < groupCount; g++) {
            const groupName = String.fromCharCode(65 + g);
            const finalMatch = allMatches.find(
              m => m.group === groupName && m.round === maxGroupRound
            );
            const gWinnerId = finalMatch?.id === matchId ? winnerId : finalMatch?.winnerId;
            if (gWinnerId) groupWinners.push(gWinnerId);
          }

          const G = groupWinners.length;
          const knockoutRounds = Math.log2(G);
          const knockoutMatchesMap: Record<string, any> = {};
          for (let r = 1; r <= knockoutRounds; r++) {
            const matchCountInRound = G / Math.pow(2, r);
            for (let idx = 0; idx < matchCountInRound; idx++) {
              knockoutMatchesMap[`${r}_${idx}`] = {
                tournamentId, round: r, matchIndex: idx, group: null, status: 'pending',
                player1Id: null, player2Id: null, winnerId: null, player1Score: 0, player2Score: 0,
              };
            }
          }
          for (let idx = 0; idx < G / 2; idx++) {
            const m = knockoutMatchesMap[`1_${idx}`];
            if (m) { m.player1Id = groupWinners[idx * 2]; m.player2Id = groupWinners[idx * 2 + 1]; }
          }
          await prisma.match.createMany({ data: Object.values(knockoutMatchesMap) });

          // Send group stage finish / knockout round ready alerts
          try {
            const r1Matches = await prisma.match.findMany({
              where: { tournamentId, round: 1, group: null },
              include: {
                player1: { select: { id: true, name: true } },
                player2: { select: { id: true, name: true } }
              }
            });
            for (const rm of r1Matches) {
              if (rm.player1Id && rm.player2Id) {
                const p1 = rm.player1?.name || 'Opponent';
                const p2 = rm.player2?.name || 'Opponent';
                await sendPushNotification(
                  rm.player1Id,
                  '🎮 Knockout Match Ready!',
                  `You advanced to the knockout stage! Your match against @${p2} is ready.`,
                  { type: 'match_ready', matchId: rm.id }
                );
                await sendPushNotification(
                  rm.player2Id,
                  '🎮 Knockout Match Ready!',
                  `You advanced to the knockout stage! Your match against @${p1} is ready.`,
                  { type: 'match_ready', matchId: rm.id }
                );
              }
            }
          } catch (err) {
            console.error('Error sending knockout stage notifications:', err);
          }
        }
      } else {
        // Advance winner inside group mini-bracket
        const nextRound = match.round + 1;
        const nextIndex = Math.floor(match.matchIndex / 2);
        const isP1 = match.matchIndex % 2 === 0;
        const nextMatch = await prisma.match.findFirst({
          where: { tournamentId, round: nextRound, matchIndex: nextIndex, group: match.group }
        });
        if (nextMatch) {
          const updatedNext = await prisma.match.update({
            where: { id: nextMatch.id },
            data: isP1 ? { player1Id: winnerId } : { player2Id: winnerId },
            include: {
              player1: { select: { id: true, name: true } },
              player2: { select: { id: true, name: true } }
            }
          });

          if (updatedNext.player1Id && updatedNext.player2Id) {
            try {
              const p1Name = updatedNext.player1?.name || 'Opponent';
              const p2Name = updatedNext.player2?.name || 'Opponent';
              await sendPushNotification(
                updatedNext.player1Id,
                `🎮 Match Ready - Round ${updatedNext.round}`,
                `Your next round match against @${p2Name} is ready! Tap to coordinate the date/time.`,
                { type: 'match_ready', matchId: updatedNext.id }
              );
              await sendPushNotification(
                updatedNext.player2Id,
                `🎮 Match Ready - Round ${updatedNext.round}`,
                `Your next round match against @${p1Name} is ready! Tap to coordinate the date/time.`,
                { type: 'match_ready', matchId: updatedNext.id }
              );
            } catch (err) {
              console.error('Error sending next round notifications:', err);
            }
          }
        }
      }
    } else if (format === 'group_points') {
      // Round-Robin — check if all group matches are done
      const pendingGroupMatches = allMatches.filter(
        m => m.group !== null && m.status !== 'completed' && m.id !== matchId
      );

      if (pendingGroupMatches.length === 0) {
        // All group stage done — compute standings & seed knockout
        const standings = await computeStandingsInternal(prisma, tournamentId);
        const groupCount = tournament.maxPlayers / groupSize;
        const advancingCount = tournament.advancingCount || 2;
        const W = advancingCount === 2 ? groupCount * 2 : groupCount;
        const knockoutRounds = Math.log2(W);
        const knockoutMatchesMap: Record<string, any> = {};

        for (let r = 1; r <= knockoutRounds; r++) {
          const matchCountInRound = W / Math.pow(2, r);
          for (let idx = 0; idx < matchCountInRound; idx++) {
            knockoutMatchesMap[`${r}_${idx}`] = {
              tournamentId, round: r, matchIndex: idx, group: null, status: 'pending',
              player1Id: null, player2Id: null, winnerId: null, player1Score: 0, player2Score: 0,
            };
          }
        }

        if (advancingCount === 2) {
          for (let k = 0; k < groupCount / 2; k++) {
            const g1 = standings[String.fromCharCode(65 + k * 2)] || [];
            const g2 = standings[String.fromCharCode(65 + k * 2 + 1)] || [];
            const mA = knockoutMatchesMap[`1_${k * 2}`];
            const mB = knockoutMatchesMap[`1_${k * 2 + 1}`];
            if (mA) { mA.player1Id = g1[0]?.playerId || null; mA.player2Id = g2[1]?.playerId || null; }
            if (mB) { mB.player1Id = g2[0]?.playerId || null; mB.player2Id = g1[1]?.playerId || null; }
          }
        } else {
          for (let idx = 0; idx < groupCount / 2; idx++) {
            const g1 = standings[String.fromCharCode(65 + idx * 2)] || [];
            const g2 = standings[String.fromCharCode(65 + idx * 2 + 1)] || [];
            const m = knockoutMatchesMap[`1_${idx}`];
            if (m) { m.player1Id = g1[0]?.playerId || null; m.player2Id = g2[0]?.playerId || null; }
          }
        }

        await prisma.match.createMany({ data: Object.values(knockoutMatchesMap) });

        // Send group stage finish / knockout round ready alerts
        try {
          const r1Matches = await prisma.match.findMany({
            where: { tournamentId, round: 1, group: null },
            include: {
              player1: { select: { id: true, name: true } },
              player2: { select: { id: true, name: true } }
            }
          });
          for (const rm of r1Matches) {
            if (rm.player1Id && rm.player2Id) {
              const p1 = rm.player1?.name || 'Opponent';
              const p2 = rm.player2?.name || 'Opponent';
              await sendPushNotification(
                rm.player1Id,
                '🎮 Knockout Match Ready!',
                `You advanced to the knockout stage! Your match against @${p2} is ready.`,
                { type: 'match_ready', matchId: rm.id }
              );
              await sendPushNotification(
                rm.player2Id,
                '🎮 Knockout Match Ready!',
                `You advanced to the knockout stage! Your match against @${p1} is ready.`,
                { type: 'match_ready', matchId: rm.id }
              );
            }
          }
        } catch (err) {
          console.error('Error sending knockout stage notifications:', err);
        }
      }
    }
  } else {
    // KNOCKOUT STAGE (group === null)
    const knockoutMatches = allMatches.filter(m => m.group === null);
    const maxRound = Math.max(...knockoutMatches.map(m => m.round));

    if (match.round === maxRound) {
      await prisma.tournament.update({
        where: { id: tournamentId },
        data: { status: 'completed' }
      });

      // Send Tournament Completed alert
      try {
        const championName = winnerId === match.player1Id ? (match.player1?.name || 'Player 1') : (match.player2?.name || 'Player 2');
        const completedTitle = `🏆 Tournament Completed!`;
        const completedBody = `Congratulations to @${championName} for winning the tournament "${tournament.name}"!`;
        
        // Save notification to history
        await prisma.notification.create({
          data: {
            storeId,
            title: completedTitle,
            body: completedBody,
          }
        });

        // Broadcast to all store players
        const playerLinks = await prisma.playerStore.findMany({
          where: { storeId },
          select: { playerId: true }
        });
        const playerIds = playerLinks.map(l => l.playerId);
        if (playerIds.length > 0) {
          await sendPushNotificationToMultiple(playerIds, completedTitle, completedBody, {
            type: 'tournament_completed',
            tournamentId
          });
        }
      } catch (err) {
        console.error('Error sending tournament completed notification:', err);
      }
    } else {
      const nextRound = match.round + 1;
      const nextIndex = Math.floor(match.matchIndex / 2);
      const isP1 = match.matchIndex % 2 === 0;
      const nextMatch = await prisma.match.findFirst({
        where: { tournamentId, round: nextRound, matchIndex: nextIndex, group: null }
      });
      if (nextMatch) {
        const updatedNext = await prisma.match.update({
          where: { id: nextMatch.id },
          data: isP1 ? { player1Id: winnerId } : { player2Id: winnerId },
          include: {
            player1: { select: { id: true, name: true } },
            player2: { select: { id: true, name: true } }
          }
        });

        if (updatedNext.player1Id && updatedNext.player2Id) {
          try {
            const p1Name = updatedNext.player1?.name || 'Opponent';
            const p2Name = updatedNext.player2?.name || 'Opponent';
            await sendPushNotification(
              updatedNext.player1Id,
              `🎮 Match Ready - Round ${updatedNext.round}`,
              `Your next round match against @${p2Name} is ready! Tap to coordinate the date/time.`,
              { type: 'match_ready', matchId: updatedNext.id }
            );
            await sendPushNotification(
              updatedNext.player2Id,
              `🎮 Match Ready - Round ${updatedNext.round}`,
              `Your next round match against @${p1Name} is ready! Tap to coordinate the date/time.`,
              { type: 'match_ready', matchId: updatedNext.id }
            );
          } catch (err) {
            console.error('Error sending next round notifications:', err);
          }
        }
      }
    }
  }

  res.json(updatedMatch);
}));

ownerRouter.put('/tournaments/:id/matches/:matchId/status', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);
  const matchId = String(req.params.matchId);
  const storeId = req.user!.storeId!;
  const { status, tableNumber } = z.object({
    status: z.enum(['pending', 'live', 'completed']),
    tableNumber: z.string().optional().nullable(),
  }).parse(req.body);

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, storeId }
  });
  if (!tournament) throw new AppError(404, 'Tournament not found');

  const updated = await prisma.match.update({
    where: { id: matchId, tournamentId },
    data: { status, tableNumber }
  });
  res.json(updated);
}));

ownerRouter.put('/matches/:id/schedule', handleAsync(async (req: Request, res: Response) => {
  const matchId = String(req.params.id);
  const storeId = req.user!.storeId!;
  const { scheduledAt } = z.object({
    scheduledAt: z.string()
  }).parse(req.body);

  const dateValue = new Date(scheduledAt);
  if (isNaN(dateValue.getTime())) {
    throw new AppError(400, 'Invalid date/time format');
  }

  // Find match & ensure it belongs to this store's tournament
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      tournament: true,
      player1: true,
      player2: true
    }
  });

  if (!match) throw new AppError(404, 'Match not found');
  if (match.tournament.storeId !== storeId) {
    throw new AppError(403, 'You do not own the store hosting this tournament');
  }
  if (match.status === 'completed') {
    throw new AppError(400, 'Cannot schedule a completed match');
  }

  // Check collision for this store
  const collision = await prisma.match.findFirst({
    where: {
      tournament: { storeId },
      scheduledAt: dateValue,
      scheduleStatus: 'confirmed',
      id: { not: matchId }
    }
  });

  if (collision) {
    throw new AppError(400, 'This time slot is already booked by another match in your store');
  }

  const updated = await prisma.match.update({
    where: { id: matchId },
    data: {
      scheduledAt: dateValue,
      proposedAt: null,
      proposedById: null,
      scheduleStatus: 'confirmed'
    }
  });

  // Notify players of referee override
  try {
    const formattedDate = dateValue.toLocaleString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });

    const overrideTitle = '📢 Referee Schedule Locked';
    const overrideBody = `Store owner locked your match for: ${formattedDate}. Check details.`;

    if (match.player1Id) {
      await sendPushNotification(
        match.player1Id,
        overrideTitle,
        overrideBody,
        { type: 'referee_override', matchId }
      );
    }
    if (match.player2Id) {
      await sendPushNotification(
        match.player2Id,
        overrideTitle,
        overrideBody,
        { type: 'referee_override', matchId }
      );
    }
  } catch (err) {
    console.error('Error sending referee override notification:', err);
  }

  res.json(updated);
}));


// ─────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────

const notificationSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

ownerRouter.post('/notifications', handleAsync(async (req: Request, res: Response) => {
  const { title, body } = notificationSchema.parse(req.body);
  const storeId = req.user!.storeId!;

  // 1. Get all players for this store
  const playerLinks = await prisma.playerStore.findMany({
    where: { storeId },
    select: { playerId: true }
  });
  const playerIds = playerLinks.map(l => l.playerId);
  
  // ALSO add the owner's playerId so they get a copy of their own broadcast
  playerIds.push(req.user!.id);

  // 2. Get all device tokens for these players
  const deviceTokens = await prisma.deviceToken.findMany({
    where: { playerId: { in: playerIds } }
  });

  const pushTokens = deviceTokens.map(dt => dt.token);

  // 3. Send using Expo
  const expo = new Expo();
  const messages = [];
  for (const pushToken of pushTokens) {
    if (!Expo.isExpoPushToken(pushToken)) {
      continue;
    }
    messages.push({
      to: pushToken,
      sound: 'default' as const,
      title,
      body,
      data: { storeId },
    });
  }

  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];
  
  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    } catch (error) {
      console.error('Error sending push notification chunk:', error);
    }
  }

  // 4. Save to DB
  const notification = await prisma.notification.create({
    data: {
      storeId,
      title,
      body,
    }
  });

  res.status(201).json({ success: true, notification, ticketsCount: tickets.length });
}));

ownerRouter.get('/notifications', handleAsync(async (req: Request, res: Response) => {
  const notifications = await prisma.notification.findMany({
    where: { storeId: req.user!.storeId! },
    orderBy: { createdAt: 'desc' },
  });
  res.json(notifications);
}));

ownerRouter.put('/tournaments/:id/blocked-slots', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);
  const storeId = req.user!.storeId!;
  const { blockedSlots } = z.object({
    blockedSlots: z.array(z.string())
  }).parse(req.body);

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId }
  });

  if (!tournament) throw new AppError(404, 'Tournament not found');
  if (tournament.storeId !== storeId) throw new AppError(403, 'Unauthorized');

  const updated = await prisma.tournament.update({
    where: { id: tournamentId },
    data: {
      blockedSlots: JSON.stringify(blockedSlots)
    }
  });

  res.json(updated);
}));

ownerRouter.delete('/matches/:id/schedule', handleAsync(async (req: Request, res: Response) => {
  const matchId = String(req.params.id);
  const storeId = req.user!.storeId!;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      tournament: true,
      player1: true,
      player2: true
    }
  });

  if (!match) throw new AppError(404, 'Match not found');
  if (match.tournament.storeId !== storeId) {
    throw new AppError(403, 'You do not own the store hosting this tournament');
  }
  if (match.status === 'completed') {
    throw new AppError(400, 'Cannot reset schedule of a completed match');
  }

  const updated = await prisma.match.update({
    where: { id: matchId },
    data: {
      scheduledAt: null,
      proposedAt: null,
      proposedById: null,
      scheduleStatus: 'unscheduled'
    }
  });

  try {
    const cancelTitle = '📢 Match Schedule Cancelled';
    const cancelBody = `Store owner has reset your match schedule. Please coordinate a new date/time.`;

    if (match.player1Id) {
      await sendPushNotification(
        match.player1Id,
        cancelTitle,
        cancelBody,
        { type: 'referee_reset', matchId }
      );
    }
    if (match.player2Id) {
      await sendPushNotification(
        match.player2Id,
        cancelTitle,
        cancelBody,
        { type: 'referee_reset', matchId }
      );
    }
  } catch (err) {
    console.error('Error sending schedule cancel notification:', err);
  }

  res.json(updated);
}));

ownerRouter.get('/tournaments/:id/replacement-candidates', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);
  const storeId = req.user!.storeId!;

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, storeId }
  });
  if (!tournament) throw new AppError(404, 'Tournament not found');

  const participants = await prisma.tournamentParticipant.findMany({
    where: { tournamentId },
    select: { playerId: true }
  });
  const participantIds = participants.map(p => p.playerId);

  const candidates = await prisma.playerStore.findMany({
    where: {
      storeId,
      playerId: { notIn: participantIds }
    },
    include: {
      player: {
        select: { id: true, name: true, username: true, avatarUrl: true, avatarSeed: true }
      }
    }
  });

  res.json(candidates.map(c => c.player));
}));

ownerRouter.put('/tournaments/:id/replace-player', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);
  const storeId = req.user!.storeId!;
  
  const { playerId, replacementPlayerId } = z.object({
    playerId: z.string().min(1),
    replacementPlayerId: z.string().min(1)
  }).parse(req.body);

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, storeId }
  });
  if (!tournament) throw new AppError(404, 'Tournament not found');

  const existingParticipant = await prisma.tournamentParticipant.findUnique({
    where: { tournamentId_playerId: { tournamentId, playerId } }
  });
  if (!existingParticipant) {
    throw new AppError(404, 'Player is not a participant in this tournament');
  }

  const isStoreMember = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId: replacementPlayerId, storeId } }
  });
  if (!isStoreMember) {
    throw new AppError(400, 'Replacement player is not registered in this store');
  }

  const isAlreadyParticipant = await prisma.tournamentParticipant.findUnique({
    where: { tournamentId_playerId: { tournamentId, playerId: replacementPlayerId } }
  });
  if (isAlreadyParticipant) {
    throw new AppError(400, 'Replacement player is already participating in this tournament');
  }

  await prisma.tournamentParticipant.delete({
    where: { tournamentId_playerId: { tournamentId, playerId } }
  });

  await prisma.tournamentParticipant.create({
    data: {
      tournamentId,
      playerId: replacementPlayerId,
      status: 'accepted',
      group: existingParticipant.group
    }
  });

  await prisma.match.updateMany({
    where: { tournamentId, player1Id: playerId },
    data: { player1Id: replacementPlayerId }
  });

  await prisma.match.updateMany({
    where: { tournamentId, player2Id: playerId },
    data: { player2Id: replacementPlayerId }
  });

  await prisma.match.updateMany({
    where: { tournamentId, winnerId: playerId },
    data: { winnerId: replacementPlayerId }
  });

  await prisma.match.updateMany({
    where: { tournamentId, proposedById: playerId },
    data: { proposedById: replacementPlayerId }
  });

  try {
    await sendPushNotification(
      playerId,
      '🏆 Replacement Announcement',
      `You have been replaced in the tournament "${tournament.name}".`,
      { type: 'tournament_replaced', tournamentId }
    );

    await sendPushNotification(
      replacementPlayerId,
      '🏆 Added to Tournament',
      `You have been added as a player in "${tournament.name}"! Your matches are ready.`,
      { type: 'tournament_added', tournamentId }
    );
  } catch (err) {
    console.error('Error sending replacement notifications:', err);
  }

  res.json({ success: true });
}));


