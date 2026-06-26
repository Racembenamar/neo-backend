import { Router, Request, Response, NextFunction } from 'express';
import { Expo } from 'expo-server-sdk';
import bcrypt from 'bcryptjs';
import { sendPushNotification, sendPushNotificationToMultiple } from '../services/notification.service';
import { formatNotificationDate } from '../lib/i18n';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { addMinutes } from 'date-fns';
import { Prisma } from '@prisma/client';
// Dynamic import used below for ESM compatibility
import { prisma } from '../lib/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { handleAsync, AppError } from '../middleware/errorHandler';
import {
  DEFAULT_WORKER_PERMISSIONS,
  WorkerPermission,
  normalizeWorkerPermissions,
} from '../lib/workerPermissions';
import {
  calculatePointsEarned,
  checkPendingUpgrade,
} from '../services/tier.service';

export const ownerRouter = Router();
ownerRouter.use(requireAuth, requireRole('owner', 'worker'));

const WORKER_ROUTE_RULES: Array<{ method: string; pattern: RegExp; permission: WorkerPermission }> = [
  { method: 'GET', pattern: /^\/games$/, permission: 'canAddGamesToSession' },
  { method: 'GET', pattern: /^\/tier-config$/, permission: 'canAccessNewSession' },
  { method: 'GET', pattern: /^\/scan-player\/[^/]+$/, permission: 'canScanPlayer' },
  { method: 'POST', pattern: /^\/sessions$/, permission: 'canConfirmBilling' },
  { method: 'GET', pattern: /^\/credits$/, permission: 'canViewCredits' },
  { method: 'GET', pattern: /^\/credits\/player\/[^/]+$/, permission: 'canViewCredits' },
  { method: 'POST', pattern: /^\/credits\/payments$/, permission: 'canCollectCreditPayments' },
  { method: 'POST', pattern: /^\/shop\/confirm-cash-payment$/, permission: 'canConfirmBilling' },
  { method: 'GET', pattern: /^\/reports\/daily$/, permission: 'canViewReports' },
  { method: 'GET', pattern: /^\/reports\/weekly$/, permission: 'canViewReports' },
  { method: 'GET', pattern: /^\/reports\/monthly$/, permission: 'canViewReports' },
  { method: 'GET', pattern: /^\/tournaments$/, permission: 'canViewTournaments' },
  { method: 'POST', pattern: /^\/tournaments$/, permission: 'canCreateTournament' },
  { method: 'PUT', pattern: /^\/tournaments\/[^/]+$/, permission: 'canEditTournament' },
  { method: 'DELETE', pattern: /^\/tournaments\/[^/]+$/, permission: 'canDeleteTournament' },
  { method: 'PATCH', pattern: /^\/tournaments\/[^/]+\/toggle$/, permission: 'canEnableDisableTournament' },
  { method: 'PUT', pattern: /^\/tournaments\/[^/]+\/participants\/[^/]+$/, permission: 'canManageParticipants' },
  { method: 'POST', pattern: /^\/tournaments\/[^/]+\/start$/, permission: 'canStartTournament' },
  { method: 'GET', pattern: /^\/tournaments\/[^/]+\/matches$/, permission: 'canViewTournaments' },
  { method: 'GET', pattern: /^\/tournaments\/[^/]+\/standings$/, permission: 'canViewTournaments' },
  { method: 'PUT', pattern: /^\/tournaments\/[^/]+\/matches\/[^/]+\/score$/, permission: 'canManageScorecard' },
  { method: 'PUT', pattern: /^\/tournaments\/[^/]+\/matches\/[^/]+\/status$/, permission: 'canManageMatches' },
  { method: 'PUT', pattern: /^\/tournaments\/[^/]+\/matches\/[^/]+\/poster$/, permission: 'canManageMatches' },
  { method: 'PUT', pattern: /^\/matches\/[^/]+\/schedule$/, permission: 'canScheduleTournament' },
  { method: 'DELETE', pattern: /^\/matches\/[^/]+\/schedule$/, permission: 'canScheduleTournament' },
  { method: 'PUT', pattern: /^\/tournaments\/[^/]+\/blocked-slots$/, permission: 'canScheduleTournament' },
  { method: 'GET', pattern: /^\/tournaments\/[^/]+\/replacement-candidates$/, permission: 'canManageParticipants' },
  { method: 'PUT', pattern: /^\/tournaments\/[^/]+\/replace-player$/, permission: 'canManageParticipants' },
  { method: 'GET', pattern: /^\/players$/, permission: 'canSearchPlayer' },
  { method: 'POST', pattern: /^\/players\/[^/]+\/notify$/, permission: 'canCreateAnnouncement' },
];

ownerRouter.use(handleAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (req.user!.role === 'owner') {
    next();
    return;
  }

  const worker = await prisma.storeWorker.findUnique({
    where: { id: req.user!.id },
    select: { id: true, storeId: true, isActive: true, permissions: true },
  });

  if (!worker || !worker.isActive) {
    throw new AppError(403, 'Worker account is disabled');
  }

  req.user!.storeId = worker.storeId;
  const rule = WORKER_ROUTE_RULES.find((candidate) =>
    candidate.method === req.method && candidate.pattern.test(req.path)
  );
  if (!rule) {
    throw new AppError(403, 'Workers do not have access to this action');
  }

  const permissions = normalizeWorkerPermissions(worker.permissions);
  if (!permissions[rule.permission]) {
    throw new AppError(403, `Missing worker permission: ${rule.permission}`);
  }

  next();
}));

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

  const creditBalance = await getPlayerCreditBalance(storeId, player.id);

  res.json({
    player,
    totalPoints: link?.totalPoints ?? 0,
    tier: link?.tier ?? 1,
    isFirstVisit: !link,
    creditBalance,
    pendingOrder
  });
}));

// ─────────────────────────────────────────────
// SESSIONS (BILLING)
// ─────────────────────────────────────────────

const sessionItemSchema = z.object({
  gameTypeId: z.string().min(1),
  quantity: z.number().positive(), // hours or number of games
  customSubtotal: z.number().nonnegative().optional(),
});

const createSessionSchema = z.object({
  playerId: z.string().min(1),
  items: z.array(sessionItemSchema).min(1),
  pointsToDeduct: z.number().int().nonnegative().optional(), // direct deduction, no QR needed
  paymentMethod: z.enum(['cash', 'points', 'credit']).optional(),
});

function creditDelta(tx: { type: string; amountDt: number }) {
  return tx.type === 'payment' ? -tx.amountDt : tx.amountDt;
}

async function getPlayerCreditBalance(storeId: string, playerId: string) {
  const transactions = await prisma.creditTransaction.findMany({
    where: { storeId, playerId },
    select: { type: true, amountDt: true },
  });

  return +transactions.reduce((sum: number, tx: { type: string; amountDt: number }) => sum + creditDelta(tx), 0).toFixed(3);
}

ownerRouter.post('/sessions', handleAsync(async (req: Request, res: Response) => {
  const { playerId, items, pointsToDeduct = 0, paymentMethod = 'cash' } = createSessionSchema.parse(req.body);
  const storeId = req.user!.storeId!;
  const workerId = req.user!.role === 'worker' ? req.user!.id : undefined;

  if (paymentMethod === 'credit' && pointsToDeduct > 0) {
    throw new AppError(400, 'Credit sessions cannot also deduct points');
  }
  if (req.user!.role === 'worker' && paymentMethod === 'credit') {
    const worker = await prisma.storeWorker.findUnique({
      where: { id: req.user!.id },
      select: { permissions: true },
    });
    const permissions = normalizeWorkerPermissions(worker?.permissions);
    if (!permissions.canAddSessionCredit) {
      throw new AppError(403, 'Missing worker permission: canAddSessionCredit');
    }
  }

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
  const sessionItems = items.map((item: { gameTypeId: string; quantity: number; customSubtotal?: number }) => {
    const gameType = gameTypes.find((g: { id: string }) => g.id === item.gameTypeId)!;
    const subtotal = item.customSubtotal !== undefined && item.customSubtotal !== null
      ? +item.customSubtotal.toFixed(3)
      : +(gameType.pricePerUnit * item.quantity).toFixed(3);
    return { gameTypeId: item.gameTypeId, quantity: item.quantity, subtotal };
  });

  const totalAmount = +sessionItems.reduce((sum, i) => sum + i.subtotal, 0).toFixed(3);
  const maxUsablePoints = Math.ceil(totalAmount * tierConfig.pointsPerDt);
  if (pointsToDeduct > maxUsablePoints) {
    throw new AppError(400, `This bill only needs up to ${maxUsablePoints} pts`);
  }

  const pointsValue = +Math.min(totalAmount, pointsToDeduct / tierConfig.pointsPerDt).toFixed(3);
  const creditAmount = paymentMethod === 'credit' ? totalAmount : 0;
  const cashAmount = paymentMethod === 'credit' ? 0 : +Math.max(0, totalAmount - pointsValue).toFixed(3);
  const normalizedPaymentMethod =
    paymentMethod === 'credit'
      ? 'credit'
      : pointsToDeduct > 0
        ? cashAmount > 0 ? 'cash_points' : 'points'
        : 'cash';

  let creditBalance = await getPlayerCreditBalance(storeId, playerId);
  const pointsEarned = creditBalance > 0 ? 0 : calculatePointsEarned(totalAmount, playerLink.tier, tierConfig);
  const newTotalPoints = playerLink.totalPoints + pointsEarned - pointsToDeduct;
  const pendingUpgrade = checkPendingUpgrade(newTotalPoints, playerLink.tier, tierConfig);

  // Persist everything in a transaction
  const session = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const s = await tx.session.create({
      data: {
        storeId,
        playerId,
        totalAmount,
        cashAmount,
        creditAmount,
        paymentMethod: normalizedPaymentMethod,
        pointsEarned,
        paidWithPoints: pointsToDeduct,
        isPaid: creditAmount <= 0,
        workerId,
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

    if (creditAmount > 0) {
      await tx.creditTransaction.create({
        data: {
          storeId,
          playerId,
          workerId,
          sessionId: s.id,
          type: 'charge',
          amountDt: creditAmount,
          note: 'Session added to player credit',
        },
      });
    }

    return s;
  });

  creditBalance = await getPlayerCreditBalance(storeId, playerId);

  if (creditAmount > 0) {
    try {
      await sendPushNotification(
        playerId,
        'Credit Added',
        `${creditAmount.toFixed(2)} DT was added to your credit. Current balance: ${creditBalance.toFixed(2)} DT.`,
        {
          type: 'credit_added',
          storeId,
          sessionId: session.id,
          amountDt: creditAmount,
          balanceDt: creditBalance,
        },
      );
    } catch (err) {
      console.error('Error sending credit added notification:', err);
    }
  }

  res.status(201).json({
    session,
    newTotalPoints,
    pointsEarned,
    pointsDeducted: pointsToDeduct,
    pendingUpgrade,
    creditBalance,
    cashAmount,
    creditAmount,
    paymentMethod: normalizedPaymentMethod,
  });
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
      worker: { select: { id: true, name: true, username: true } },
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
      worker: { select: { id: true, name: true, username: true } },
      items: { include: { gameType: true } },
    },
  });
  if (!session) throw new AppError(404, 'Session not found');
  res.json(session);
}));

// CREDIT LEDGER

const creditPaymentSchema = z.object({
  playerId: z.string().min(1),
  amountDt: z.number().positive(),
  note: z.string().max(200).optional(),
});

ownerRouter.get('/credits', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const transactions = await prisma.creditTransaction.findMany({
    where: { storeId },
    include: {
      player: { select: { id: true, name: true, username: true, phone: true } },
      worker: { select: { id: true, name: true, username: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const players = new Map<string, any>();
  for (const tx of transactions) {
    const existing = players.get(tx.playerId) ?? {
      player: tx.player,
      balance: 0,
      creditAdded: 0,
      creditPaid: 0,
      transactionCount: 0,
      lastTransactionAt: tx.createdAt,
      lastWorker: tx.worker,
    };

    existing.balance += creditDelta(tx);
    existing.transactionCount += 1;
    if (tx.type === 'payment') existing.creditPaid += tx.amountDt;
    else existing.creditAdded += tx.amountDt;

    if (new Date(tx.createdAt).getTime() > new Date(existing.lastTransactionAt).getTime()) {
      existing.lastTransactionAt = tx.createdAt;
      existing.lastWorker = tx.worker;
    }

    players.set(tx.playerId, existing);
  }

  res.json(Array.from(players.values())
    .map(playerCredit => ({
      ...playerCredit,
      balance: +playerCredit.balance.toFixed(3),
      creditAdded: +playerCredit.creditAdded.toFixed(3),
      creditPaid: +playerCredit.creditPaid.toFixed(3),
    }))
    .filter(playerCredit => Math.abs(playerCredit.balance) > 0.0001)
    .sort((a, b) => b.balance - a.balance));
}));

ownerRouter.get('/credits/player/:playerId', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const playerId = String(req.params.playerId);
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, name: true, username: true, phone: true },
  });
  if (!player) throw new AppError(404, 'Player not found');

  const transactions = await prisma.creditTransaction.findMany({
    where: { storeId, playerId },
    include: {
      worker: { select: { id: true, name: true, username: true } },
      session: { select: { id: true, totalAmount: true, paymentMethod: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const balance = +transactions.reduce((sum: number, tx: { type: string; amountDt: number }) => sum + creditDelta(tx), 0).toFixed(3);
  res.json({ player, balance, transactions });
}));

ownerRouter.post('/credits/payments', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const workerId = req.user!.role === 'worker' ? req.user!.id : undefined;
  const data = creditPaymentSchema.parse(req.body);

  const player = await prisma.player.findUnique({
    where: { id: data.playerId },
    select: { id: true, name: true, username: true },
  });
  if (!player) throw new AppError(404, 'Player not found');

  const balance = await getPlayerCreditBalance(storeId, data.playerId);
  if (balance <= 0) {
    throw new AppError(400, 'This player has no unpaid credit');
  }
  if (data.amountDt > balance) {
    throw new AppError(400, `Payment is higher than current credit balance (${balance.toFixed(2)} DT)`);
  }

  const transaction = await prisma.creditTransaction.create({
    data: {
      storeId,
      playerId: data.playerId,
      workerId,
      type: 'payment',
      amountDt: +data.amountDt.toFixed(3),
      note: data.note ?? 'Credit payment collected',
    },
  });
  const newBalance = +(balance - data.amountDt).toFixed(3);

  try {
    await sendPushNotification(
      data.playerId,
      newBalance <= 0 ? 'Credit Fully Paid' : 'Credit Payment Received',
      newBalance <= 0
        ? `${data.amountDt.toFixed(2)} DT was paid. Your credit balance is now clear.`
        : `${data.amountDt.toFixed(2)} DT was paid from your credit. Remaining balance: ${newBalance.toFixed(2)} DT.`,
      {
        type: 'credit_paid',
        storeId,
        amountDt: +data.amountDt.toFixed(3),
        balanceDt: newBalance,
      },
    );
  } catch (err) {
    console.error('Error sending credit payment notification:', err);
  }

  res.status(201).json({
    transaction,
    player,
    balance: newBalance,
  });
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

const productBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  priceInPoints: z.number().int().positive().optional().nullable(),
  priceInDt: z.number().positive().optional().nullable(),
  imageUrl: z.string().optional(),
});

const productSchema = productBaseSchema.refine((data) => data.priceInPoints != null || data.priceInDt != null, {
  message: 'Product must have a points price, a cash price, or both.',
});

const productUpdateSchema = productBaseSchema.partial().refine((data) => {
  if ('priceInPoints' in data || 'priceInDt' in data) {
    return data.priceInPoints != null || data.priceInDt != null;
  }
  return true;
}, {
  message: 'Product must have a points price, a cash price, or both.',
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
  const data = productUpdateSchema.parse(req.body);
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

    const creditTransactions = await tx.creditTransaction.findMany({
      where: { storeId, playerId: order.playerId },
      select: { type: true, amountDt: true },
    });
    const creditBalance = +creditTransactions.reduce((sum: number, tx: { type: string; amountDt: number }) => sum + creditDelta(tx), 0).toFixed(3);
    const finalPointsEarned = creditBalance > 0 ? 0 : order.pointsToEarn;

    if (playerLink) {
      await tx.playerStore.update({
        where: { id: playerLink.id },
        data: { totalPoints: { increment: finalPointsEarned } }
      });
    } else {
      await tx.playerStore.create({
        data: {
          playerId: order.playerId,
          storeId,
          totalPoints: finalPointsEarned,
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
        pointsEarned: finalPointsEarned,
        workerId: req.user!.role === 'worker' ? req.user!.id : undefined
      }
    });

    return order;
  });

  res.json(result);
}));

// ─────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────

function sessionPointsValue(session: any, pointsPerDt: number) {
  return +Math.min(session.totalAmount, (session.paidWithPoints ?? 0) / pointsPerDt).toFixed(3);
}

function sessionCreditValue(session: any) {
  if (session.paymentMethod === 'credit') {
    return +(session.creditAmount || session.totalAmount || 0).toFixed(3);
  }
  return +(session.creditAmount ?? 0).toFixed(3);
}

function sessionCashValue(session: any, pointsPerDt: number) {
  if (session.paymentMethod === 'credit') return 0;
  if ((session.cashAmount ?? 0) > 0) return +session.cashAmount.toFixed(3);

  const pointsValue = sessionPointsValue(session, pointsPerDt);
  return +Math.max(0, session.totalAmount - pointsValue).toFixed(3);
}

async function buildStoreReport(storeId: string, from: Date, to?: Date) {
  const createdAt = to ? { gte: from, lt: to } : { gte: from };
  const tierConfig = await prisma.tierConfig.findUnique({ where: { storeId } });
  const pointsPerDt = tierConfig?.pointsPerDt || 50;

  const [sessions, purchases, creditTransactions, allCreditTransactions] = await Promise.all([
    prisma.session.findMany({
      where: { storeId, createdAt },
      include: { items: { include: { gameType: { select: { name: true } } } } },
    }),
    prisma.purchase.findMany({
      where: { storeId, createdAt },
    }),
    prisma.creditTransaction.findMany({
      where: { storeId, createdAt },
    }),
    prisma.creditTransaction.findMany({
      where: { storeId },
      select: { type: true, amountDt: true },
    }),
  ]);

  const byDay: Record<string, { cashRevenue: number; pointsValue: number; serviceValue: number; creditAdded: number; creditPaid: number }> = {};
  const topGames: Record<string, { name: string; count: number; revenue: number; serviceValue: number }> = {};

  let sessionCashRevenue = 0;
  let sessionPointsTotal = 0;
  let sessionServiceValue = 0;

  sessions.forEach((session: any) => {
    const day = session.createdAt.toISOString().split('T')[0];
    const pointsValue = sessionPointsValue(session, pointsPerDt);
    const cashRevenue = sessionCashValue(session, pointsPerDt);
    const creditAdded = sessionCreditValue(session);

    sessionServiceValue += session.totalAmount;
    sessionPointsTotal += pointsValue;
    sessionCashRevenue += cashRevenue;

    if (!byDay[day]) byDay[day] = { cashRevenue: 0, pointsValue: 0, serviceValue: 0, creditAdded: 0, creditPaid: 0 };
    byDay[day].cashRevenue += cashRevenue;
    byDay[day].pointsValue += pointsValue;
    byDay[day].serviceValue += session.totalAmount;
    byDay[day].creditAdded += creditAdded;

    session.items.forEach((item: any) => {
      const name = item.gameType.name;
      if (!topGames[name]) topGames[name] = { name, count: 0, revenue: 0, serviceValue: 0 };
      topGames[name].count += 1;
      topGames[name].revenue += item.subtotal;
      topGames[name].serviceValue += item.subtotal;
    });
  });

  const purchaseCashRevenue = purchases.reduce((sum: number, purchase: any) => sum + (purchase.cashSpent ?? 0), 0);
  const purchasePointsValue = purchases.reduce((sum: number, purchase: any) => sum + ((purchase.pointsSpent ?? 0) / pointsPerDt), 0);
  const purchaseServiceValue = purchaseCashRevenue + purchasePointsValue;
  const creditPaid = creditTransactions
    .filter((tx: any) => tx.type === 'payment')
    .reduce((sum: number, tx: any) => sum + (tx.amountDt ?? 0), 0);
  const creditAdded = creditTransactions
    .filter((tx: any) => tx.type !== 'payment')
    .reduce((sum: number, tx: any) => sum + (tx.amountDt ?? 0), 0);
  const outstandingCredit = allCreditTransactions.reduce(
    (sum: number, tx: { type: string; amountDt: number }) => sum + creditDelta(tx),
    0,
  );

  creditTransactions.forEach((tx: any) => {
    const day = tx.createdAt.toISOString().split('T')[0];
    if (!byDay[day]) byDay[day] = { cashRevenue: 0, pointsValue: 0, serviceValue: 0, creditAdded: 0, creditPaid: 0 };
    if (tx.type === 'payment') {
      byDay[day].cashRevenue += tx.amountDt;
      byDay[day].creditPaid += tx.amountDt;
    } else {
      byDay[day].creditAdded += tx.amountDt;
    }
  });

  const pointsEarned = sessions.reduce((sum: number, session: any) => sum + session.pointsEarned, 0)
    + purchases.reduce((sum: number, purchase: any) => sum + (purchase.pointsEarned ?? 0), 0);
  const pointsDeducted = sessions.reduce((sum: number, session: any) => sum + session.paidWithPoints, 0)
    + purchases.reduce((sum: number, purchase: any) => sum + purchase.pointsSpent, 0);

  return {
    totalRevenue: +(sessionCashRevenue + purchaseCashRevenue + creditPaid).toFixed(3),
    cashRevenue: +(sessionCashRevenue + purchaseCashRevenue + creditPaid).toFixed(3),
    pointsValue: +(sessionPointsTotal + purchasePointsValue).toFixed(3),
    serviceValue: +(sessionServiceValue + purchaseServiceValue).toFixed(3),
    creditAdded: +creditAdded.toFixed(3),
    creditPaid: +creditPaid.toFixed(3),
    outstandingCredit: +outstandingCredit.toFixed(3),
    pointsEarned,
    pointsDeducted,
    sessionCount: sessions.length,
    purchaseCount: purchases.length,
    creditSessionCount: sessions.filter((session: any) => sessionCreditValue(session) > 0).length,
    creditPaymentCount: creditTransactions.filter((tx: any) => tx.type === 'payment').length,
    transactionCount: sessions.length + purchases.length + creditTransactions.filter((tx: any) => tx.type === 'payment').length,
    topGames: Object.values(topGames)
      .map(game => ({
        ...game,
        revenue: +game.revenue.toFixed(3),
        serviceValue: +game.serviceValue.toFixed(3),
      }))
      .sort((a, b) => b.serviceValue - a.serviceValue),
    dailyBreakdown: Object.entries(byDay)
      .map(([date, values]) => ({
        date,
        cashRevenue: +values.cashRevenue.toFixed(3),
        pointsValue: +values.pointsValue.toFixed(3),
        serviceValue: +values.serviceValue.toFixed(3),
        creditAdded: +values.creditAdded.toFixed(3),
        creditPaid: +values.creditPaid.toFixed(3),
        revenue: +values.cashRevenue.toFixed(3),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

ownerRouter.get('/reports/daily', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const report = await buildStoreReport(storeId, today, tomorrow);
  res.json({ date: today.toISOString().split('T')[0], ...report });
}));

ownerRouter.get('/reports/weekly', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 6);
  const report = await buildStoreReport(storeId, weekStart);
  res.json({ weekStart: weekStart.toISOString().split('T')[0], ...report });
}));

ownerRouter.get('/reports/monthly', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const report = await buildStoreReport(storeId, firstOfMonth);
  res.json({ month: firstOfMonth.toISOString().split('T')[0].slice(0, 7), ...report });
}));

// ─────────────────────────────────────────────
// TOURNAMENTS
// ─────────────────────────────────────────────

// WORKERS

const workerPermissionInputSchema = z.record(z.string(), z.boolean());

const workerCreateSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  name: z.string().min(2),
  phone: z.string().optional().nullable(),
  permissions: workerPermissionInputSchema.optional(),
});

const workerUpdateSchema = z.object({
  password: z.string().min(6).optional(),
  name: z.string().min(2).optional(),
  phone: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  permissions: workerPermissionInputSchema.optional(),
});

function workerDateRanges() {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 6);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  return { today, tomorrow, weekStart, monthStart };
}

function workerResponse(worker: any) {
  return {
    id: worker.id,
    username: worker.username,
    name: worker.name,
    phone: worker.phone,
    isActive: worker.isActive,
    permissions: normalizeWorkerPermissions(worker.permissions),
    createdAt: worker.createdAt,
    updatedAt: worker.updatedAt,
  };
}

async function assertUsernameAvailable(username: string) {
  const [admin, player, worker] = await Promise.all([
    prisma.admin.findUnique({ where: { username } }),
    prisma.player.findUnique({ where: { username } }),
    prisma.storeWorker.findUnique({ where: { username } }),
  ]);

  if (admin || player || worker) {
    throw new AppError(400, 'Username already exists');
  }
}

async function workerStatsForRange(storeId: string, workerId: string, from: Date, to?: Date, includeTransactions = false, pointsPerDt = 50) {
  const createdAt = to ? { gte: from, lt: to } : { gte: from };

  const [sessions, purchases, creditTransactions] = await Promise.all([
    prisma.session.findMany({
      where: { storeId, workerId, createdAt },
      include: includeTransactions
        ? {
            player: { select: { id: true, name: true, username: true } },
            items: { include: { gameType: { select: { name: true } } } },
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take: includeTransactions ? 100 : undefined,
    }),
    prisma.purchase.findMany({
      where: { storeId, workerId, createdAt },
      include: includeTransactions
        ? { player: { select: { id: true, name: true, username: true } } }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take: includeTransactions ? 100 : undefined,
    }),
    prisma.creditTransaction.findMany({
      where: { storeId, workerId, createdAt },
      include: includeTransactions
        ? { player: { select: { id: true, name: true, username: true } } }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take: includeTransactions ? 100 : undefined,
    }),
  ]);

  const sessionServiceValue = sessions.reduce((sum: number, session: any) => sum + session.totalAmount, 0);
  const sessionPointsTotal = sessions.reduce((sum: number, session: any) => sum + sessionPointsValue(session, pointsPerDt), 0);
  const sessionCashRevenue = sessions.reduce((sum: number, session: any) => sum + sessionCashValue(session, pointsPerDt), 0);
  const sessionCreditAdded = sessions.reduce((sum: number, session: any) => sum + sessionCreditValue(session), 0);

  const purchaseCashRevenue = purchases.reduce((sum: number, purchase: any) => sum + (purchase.cashSpent ?? 0), 0);
  const purchasePointsValue = purchases.reduce((sum: number, purchase: any) => sum + ((purchase.pointsSpent ?? 0) / pointsPerDt), 0);
  const purchaseServiceValue = purchaseCashRevenue + purchasePointsValue;
  const creditPaid = creditTransactions
    .filter((tx: any) => tx.type === 'payment')
    .reduce((sum: number, tx: any) => sum + (tx.amountDt ?? 0), 0);

  const pointsEarned = sessions.reduce((sum: number, session: any) => sum + session.pointsEarned, 0)
    + purchases.reduce((sum: number, purchase: any) => sum + (purchase.pointsEarned ?? 0), 0);
  const pointsDeducted = sessions.reduce((sum: number, session: any) => sum + session.paidWithPoints, 0)
    + purchases.reduce((sum: number, purchase: any) => sum + purchase.pointsSpent, 0);

  const transactions = includeTransactions
    ? [
        ...sessions.map((session: any) => ({
          id: session.id,
          type: 'session',
          player: session.player,
          totalAmount: session.totalAmount,
          cashAmount: sessionCashValue(session, pointsPerDt),
          creditAmount: sessionCreditValue(session),
          pointsValue: sessionPointsValue(session, pointsPerDt),
          paymentMethod: session.paymentMethod,
          pointsEarned: session.pointsEarned,
          pointsDeducted: session.paidWithPoints,
          items: session.items,
          createdAt: session.createdAt,
        })),
        ...purchases.map((purchase: any) => ({
          id: purchase.id,
          type: 'purchase',
          player: purchase.player,
          productName: purchase.productName,
          totalAmount: (purchase.cashSpent ?? 0) + ((purchase.pointsSpent ?? 0) / pointsPerDt),
          cashAmount: purchase.cashSpent ?? 0,
          pointsValue: (purchase.pointsSpent ?? 0) / pointsPerDt,
          pointsEarned: purchase.pointsEarned ?? 0,
          pointsDeducted: purchase.pointsSpent,
          createdAt: purchase.createdAt,
        })),
        ...creditTransactions
          .filter((tx: any) => tx.type === 'payment')
          .map((tx: any) => ({
            id: tx.id,
            type: 'credit_payment',
            player: tx.player,
            totalAmount: tx.amountDt,
            cashAmount: tx.amountDt,
            creditAmount: 0,
            pointsValue: 0,
            note: tx.note,
            createdAt: tx.createdAt,
          })),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    : undefined;

  return {
    transactionCount: sessions.length + purchases.length + creditTransactions.filter((tx: any) => tx.type === 'payment').length,
    sessionCount: sessions.length,
    purchaseCount: purchases.length,
    creditPaymentCount: creditTransactions.filter((tx: any) => tx.type === 'payment').length,
    revenue: +(sessionCashRevenue + purchaseCashRevenue + creditPaid).toFixed(3),
    cashRevenue: +(sessionCashRevenue + purchaseCashRevenue + creditPaid).toFixed(3),
    pointsValue: +(sessionPointsTotal + purchasePointsValue).toFixed(3),
    serviceValue: +(sessionServiceValue + purchaseServiceValue).toFixed(3),
    creditAdded: +sessionCreditAdded.toFixed(3),
    creditPaid: +creditPaid.toFixed(3),
    pointsEarned,
    pointsDeducted,
    transactions,
  };
}

async function workerPeriodStats(storeId: string, workerId: string, includeTransactions = false) {
  const { today, tomorrow, weekStart, monthStart } = workerDateRanges();
  const tierConfig = await prisma.tierConfig.findUnique({ where: { storeId } });
  const pointsPerDt = tierConfig?.pointsPerDt || 50;
  const [daily, weekly, monthly] = await Promise.all([
    workerStatsForRange(storeId, workerId, today, tomorrow, includeTransactions, pointsPerDt),
    workerStatsForRange(storeId, workerId, weekStart, undefined, includeTransactions, pointsPerDt),
    workerStatsForRange(storeId, workerId, monthStart, undefined, includeTransactions, pointsPerDt),
  ]);
  return { daily, weekly, monthly };
}

ownerRouter.get('/workers', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const workers = await prisma.storeWorker.findMany({
    where: { storeId },
    orderBy: { createdAt: 'desc' },
  });

  const enrichedWorkers = await Promise.all(workers.map(async (worker: any) => ({
    ...workerResponse(worker),
    stats: await workerPeriodStats(storeId, worker.id),
  })));

  res.json(enrichedWorkers);
}));

ownerRouter.post('/workers', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const data = workerCreateSchema.parse(req.body);

  await assertUsernameAvailable(data.username);

  const worker = await prisma.storeWorker.create({
    data: {
      storeId,
      createdByOwnerId: req.user!.id,
      username: data.username,
      passwordHash: await bcrypt.hash(data.password, 10),
      name: data.name,
      phone: data.phone ?? null,
      permissions: normalizeWorkerPermissions(data.permissions ?? DEFAULT_WORKER_PERMISSIONS),
    },
  });

  res.status(201).json(workerResponse(worker));
}));

ownerRouter.put('/workers/:id', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const workerId = String(req.params.id);
  const data = workerUpdateSchema.parse(req.body);

  const worker = await prisma.storeWorker.findFirst({ where: { id: workerId, storeId } });
  if (!worker) throw new AppError(404, 'Worker not found');

  const updateData: any = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.phone !== undefined) updateData.phone = data.phone ?? null;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 10);
  if (data.permissions) {
    updateData.permissions = normalizeWorkerPermissions({
      ...normalizeWorkerPermissions(worker.permissions),
      ...data.permissions,
    });
  }

  const updated = await prisma.storeWorker.update({
    where: { id: workerId },
    data: updateData,
  });

  res.json(workerResponse(updated));
}));

ownerRouter.delete('/workers/:id', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const workerId = String(req.params.id);

  const worker = await prisma.storeWorker.findFirst({ where: { id: workerId, storeId } });
  if (!worker) throw new AppError(404, 'Worker not found');

  await prisma.storeWorker.update({
    where: { id: workerId },
    data: { isActive: false },
  });

  res.json({ success: true });
}));

ownerRouter.get('/workers/:id/stats', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const workerId = String(req.params.id);

  const worker = await prisma.storeWorker.findFirst({ where: { id: workerId, storeId } });
  if (!worker) throw new AppError(404, 'Worker not found');

  res.json({
    worker: workerResponse(worker),
    stats: await workerPeriodStats(storeId, workerId, true),
  });
}));

const prizeDistributionSchema = z.array(z.object({
  rank: z.number().int().min(1),
  amount: z.string().min(1),
})).nullable().optional();

const tournamentSchema = z.object({
  name: z.string().min(1),
  date: z.string().or(z.date()), // accepts ISO string
  prizePool: z.string().min(1),
  prizeDistribution: prizeDistributionSchema,
  entryPrice: z.string().optional(),
  maxPlayers: z.number().int().positive(),
  status: z.enum(['open', 'coming_soon', 'completed']).optional(),
  imageUrl: z.string().optional(),
  format: z.enum(['single_elimination', 'group_knockout', 'group_points']).optional(),
  groupSize: z.number().int().positive().nullable().optional(),
  advancingCount: z.number().int().positive().nullable().optional(),
  schedulingRange: z.number().int().min(1).max(90).optional(),
});

type PrizeDistributionInput = z.infer<typeof prizeDistributionSchema>;

function parseMoneyToCents(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  const match = normalized.match(/^(\d+(?:\.\d{1,2})?)(?:\s*dt)?$/i);
  if (!match) return null;
  return Math.round(Number(match[1]) * 100);
}

function getMaxPaidPlaces(maxPlayers: number): number {
  if (maxPlayers > 32) return 6;
  if (maxPlayers > 16) return 4;
  return 3;
}

function normalizePrizeDistribution(
  prizePool: string,
  maxPlayers: number,
  prizeDistribution: PrizeDistributionInput
): string | null | undefined {
  if (prizeDistribution === undefined) return undefined;
  if (!prizeDistribution || prizeDistribution.length === 0) return null;

  const maxPaidPlaces = getMaxPaidPlaces(maxPlayers);
  if (prizeDistribution.length > maxPaidPlaces) {
    throw new AppError(400, `This tournament size allows a maximum of Top ${maxPaidPlaces} prize winners`);
  }

  const sortedDistribution = [...prizeDistribution].sort((a, b) => a.rank - b.rank);
  const ranks = sortedDistribution.map(item => item.rank);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) {
      throw new AppError(400, 'Prize winners must be ranked from 1st place without gaps');
    }
  }

  const prizePoolCents = parseMoneyToCents(prizePool);
  if (prizePoolCents === null) {
    throw new AppError(400, 'Prize Pool must be a numeric amount when prize split is enabled');
  }

  const distributionCents = sortedDistribution.map(item => parseMoneyToCents(item.amount));
  if (distributionCents.some(amount => amount === null)) {
    throw new AppError(400, 'Each prize split amount must be numeric');
  }

  const totalCents = distributionCents.reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
  if (totalCents !== prizePoolCents) {
    throw new AppError(400, 'Prize split total must equal the Prize Pool');
  }

  return JSON.stringify(sortedDistribution);
}

ownerRouter.get('/tournaments', handleAsync(async (req: Request, res: Response) => {
  // Auto-open tournaments that have reached their scheduled date/time
  await prisma.tournament.updateMany({
    where: {
      status: 'coming_soon',
      date: { lte: new Date() }
    },
    data: {
      status: 'open'
    }
  });

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
  const normalizedPrizeDistribution = normalizePrizeDistribution(
    data.prizePool,
    data.maxPlayers,
    data.prizeDistribution
  );

  const tournament = await prisma.tournament.create({
    data: {
      ...data,
      prizeDistribution: normalizedPrizeDistribution ?? null,
      date: new Date(data.date),
      storeId,
      isActive: data.format === 'group_points' ? false : true,
    },
  });

  // Draft dynamic themed announcement
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  
  let title = `🏆 New Tournament in ${store?.name || 'NEO'}`;
  let body = `Join the new tournament: ${tournament.name}! Prize Pool: ${tournament.prizePool}.`;

  const cleanDate = formatNotificationDate(new Date(tournament.date));

  const entryText = tournament.entryPrice && tournament.entryPrice.toLowerCase() !== 'free'
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
      type: 'tournament_created',
      data: JSON.stringify({ tournamentId: tournament.id, storeId })
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
      tournamentId: tournament.id,
      storeId
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

  const prizePoolForValidation = data.prizePool ?? existing.prizePool;
  const maxPlayersForValidation = data.maxPlayers ?? existing.maxPlayers;
  const normalizedPrizeDistribution = normalizePrizeDistribution(
    prizePoolForValidation,
    maxPlayersForValidation,
    data.prizeDistribution
  );
  if (normalizedPrizeDistribution !== undefined) {
    updateData.prizeDistribution = normalizedPrizeDistribution;
  }

  if (data.format === 'group_points' && existing.format !== 'group_points') {
    updateData.isActive = false;
    updateData.groupPointsApproved = false;
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
  if (!current.isActive && current.format === 'group_points' && !current.groupPointsApproved) {
    throw new AppError(403, 'Cannot activate Group Points tournament without admin permission');
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

  const existingParticipant = await prisma.tournamentParticipant.findUnique({
    where: {
      tournamentId_playerId: { tournamentId, playerId }
    },
    select: { status: true }
  });

  if (!existingParticipant) throw new AppError(404, 'Participant not found');

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

  if ((status === 'accepted' || status === 'rejected') && existingParticipant.status !== status) {
    try {
      const wasAccepted = status === 'accepted';
      await sendPushNotification(
        playerId,
        wasAccepted ? 'Tournament Registration Approved' : 'Tournament Registration Declined',
        wasAccepted
          ? `Your registration for "${tournament.name}" has been approved.`
          : `Your registration for "${tournament.name}" has been declined.`,
        {
          type: wasAccepted ? 'tournament_registration_accepted' : 'tournament_registration_rejected',
          tournamentId,
          storeId
        }
      );
    } catch (err) {
      console.error('Error sending tournament registration status notification:', err);
    }
  }

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

  // Auto-open tournaments that have reached their scheduled date/time
  await prisma.tournament.updateMany({
    where: {
      status: 'coming_soon',
      date: { lte: new Date() }
    },
    data: {
      status: 'open'
    }
  });

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

ownerRouter.put('/tournaments/:id/matches/:matchId/poster', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);
  const matchId = String(req.params.matchId);
  const storeId = req.user!.storeId!;
  const { posterUrl } = z.object({
    posterUrl: z.string().optional().nullable(),
  }).parse(req.body);

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, storeId }
  });
  if (!tournament) throw new AppError(404, 'Tournament not found');

  const updated = await prisma.match.update({
    where: { id: matchId, tournamentId },
    data: { posterUrl: posterUrl || null }
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
    const formattedDate = formatNotificationDate(dateValue);

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

  // 1. Get all players for this store who haven't muted notifications
  const playerLinks = await prisma.playerStore.findMany({
    where: { 
      storeId,
      notificationsMuted: false
    },
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
      data: { storeId, type: 'broadcast' },
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

  // 4. Save broadcast template (with playerId: null) for owner's sent logs
  const notification = await prisma.notification.create({
    data: {
      storeId,
      playerId: null,
      title,
      body,
      type: 'broadcast',
      isRead: false
    }
  });

  // 5. Save a copy of the notification for each player in the store (inboxes)
  if (playerIds.length > 0) {
    await prisma.notification.createMany({
      data: playerIds.map(pId => ({
        storeId,
        playerId: pId,
        title,
        body,
        type: 'broadcast',
        isRead: false
      }))
    });
  }

  res.status(201).json({ success: true, notification, ticketsCount: tickets.length });
}));

ownerRouter.get('/notifications', handleAsync(async (req: Request, res: Response) => {
  const ownerId = req.user!.id;
  const notifications = await prisma.notification.findMany({
    where: { 
      storeId: req.user!.storeId!,
      OR: [
        { playerId: null },
        { playerId: ownerId }
      ]
    },
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

// ─────────────────────────────────────────────
// STORE PROFILE MANAGEMENT
// ─────────────────────────────────────────────

const storeUpdateSchema = z.object({
  name: z.string().min(1),
  city: z.string().optional().nullable(),
  route: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  logoUrl: z.string().optional().nullable(),
  bannerUrl: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  openingHours: z.string().optional().nullable(),
  wifiSsid: z.string().optional().nullable(),
  wifiPassword: z.string().optional().nullable(),
  instagramUrl: z.string().optional().nullable(),
  facebookUrl: z.string().optional().nullable(),
  discordUrl: z.string().optional().nullable(),
  googleMapsUrl: z.string().optional().nullable(),
});

ownerRouter.get('/store', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const store = await prisma.store.findUnique({
    where: { id: storeId },
  });
  if (!store) throw new AppError(404, 'Store not found');
  res.json(store);
}));

ownerRouter.put('/store', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const data = storeUpdateSchema.parse(req.body);
  const updatedStore = await prisma.store.update({
    where: { id: storeId },
    data,
  });
  res.json(updatedStore);
}));

// ─────────────────────────────────────────────
// PLAYERS (CLIENTS) MANAGEMENT
// ─────────────────────────────────────────────

ownerRouter.get('/players', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;

  // Fetch players who have at least one session, purchase, or credit transaction in the store
  const players = await prisma.player.findMany({
    where: {
      OR: [
        { sessions: { some: { storeId } } },
        { purchases: { some: { storeId } } },
        { creditTransactions: { some: { storeId } } },
      ],
    },
    select: {
      id: true,
      name: true,
      username: true,
      phone: true,
      avatarUrl: true,
      avatarSeed: true,
      createdAt: true,
      storeLinks: {
        where: { storeId },
        select: {
          tier: true,
          totalPoints: true,
          joinedAt: true,
        },
      },
      sessions: {
        where: { storeId },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
      purchases: {
        where: { storeId },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
      creditTransactions: {
        where: { storeId },
        select: { type: true, amountDt: true, createdAt: true },
      },
    },
  });

  const formattedPlayers = players.map(player => {
    const link = player.storeLinks[0];
    
    // Calculate last active timestamp
    const dates = [
      player.sessions[0]?.createdAt,
      player.purchases[0]?.createdAt,
      ...player.creditTransactions.slice(0, 1).map(t => t.createdAt)
    ].filter(Boolean) as Date[];
    
    const lastActiveAt = dates.length > 0
      ? new Date(Math.max(...dates.map(d => new Date(d).getTime())))
      : player.createdAt;

    // Calculate credit balance
    const creditBalance = +player.creditTransactions.reduce(
      (sum, tx) => sum + (tx.type === 'payment' ? -tx.amountDt : tx.amountDt),
      0
    ).toFixed(3);

    return {
      id: player.id,
      name: player.name,
      username: player.username,
      phone: player.phone,
      avatarUrl: player.avatarUrl,
      avatarSeed: player.avatarSeed,
      tier: link?.tier ?? 1,
      points: link?.totalPoints ?? 0,
      joinedAt: link?.joinedAt ?? player.createdAt,
      lastActiveAt,
      creditBalance,
    };
  });

  res.json(formattedPlayers);
}));

ownerRouter.post('/players/:id/notify', handleAsync(async (req: Request, res: Response) => {
  const storeId = req.user!.storeId!;
  const playerId = String(req.params.id);
  
  const notifySchema = z.object({
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(500),
  });
  
  const { title, body } = notifySchema.parse(req.body);
  
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true },
  });
  if (!player) throw new AppError(404, 'Player not found');
  
  // Verify they are associated with the store
  const link = await prisma.playerStore.findUnique({
    where: { playerId_storeId: { playerId, storeId } },
  });
  if (!link) {
    // Check if they had at least one transaction as fallback
    const hasTx = await prisma.creditTransaction.findFirst({ where: { storeId, playerId } }) ||
                 await prisma.session.findFirst({ where: { storeId, playerId } }) ||
                 await prisma.purchase.findFirst({ where: { storeId, playerId } });
    if (!hasTx) {
      throw new AppError(400, 'Player is not associated with this store');
    }
  }
  
  // Create system notification
  await prisma.notification.create({
    data: {
      storeId,
      playerId,
      title,
      body,
      type: 'custom_alert',
    },
  });
  
  // Send push notification
  try {
    await sendPushNotification(playerId, title, body, {
      type: 'custom_alert',
      storeId,
    });
  } catch (err) {
    console.error('Failed to send push notification to player:', err);
  }
  
  res.json({ success: true });
}));


