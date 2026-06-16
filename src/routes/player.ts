import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { handleAsync, AppError } from '../middleware/errorHandler';
import { z } from 'zod';
import { sendPushNotification } from '../services/notification.service';
import { checkPendingUpgrade } from '../services/tier.service';

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

  if (link.store.tierConfig) {
    const isEligible = checkPendingUpgrade(link.totalPoints, link.tier, link.store.tierConfig);
    if (link.pendingUpgrade !== isEligible) {
      await prisma.playerStore.update({
        where: { playerId_storeId: { playerId, storeId } },
        data: { pendingUpgrade: isEligible }
      });
      link.pendingUpgrade = isEligible;
    }
  }

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
      earned: p.pointsEarned || 0,
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
  if (!link.store.tierConfig) throw new AppError(500, 'Tier config missing');

  // Dynamically update eligibility in case config changed
  const isEligible = checkPendingUpgrade(link.totalPoints, link.tier, link.store.tierConfig);
  if (link.pendingUpgrade !== isEligible) {
    await prisma.playerStore.update({
      where: { playerId_storeId: { playerId, storeId } },
      data: { pendingUpgrade: isEligible }
    });
    link.pendingUpgrade = isEligible;
  }

  if (!link.pendingUpgrade) throw new AppError(400, 'No tier upgrade available');
  if (link.tier >= 5) throw new AppError(400, 'Already at maximum tier');

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
    include: { store: { include: { tierConfig: true } } },
  });
  
  if (!link) throw new AppError(404, 'Not enrolled in this store');
  if (link.totalPoints < product.priceInPoints) {
    throw new AppError(400, 'Insufficient points to purchase this item');
  }
  if (!link.store.tierConfig) throw new AppError(500, 'Tier config missing');

  const newTotalPoints = link.totalPoints - product.priceInPoints;
  const pendingUpgrade = checkPendingUpgrade(newTotalPoints, link.tier, link.store.tierConfig);

  // Deduct points and create purchase record in a transaction
  const [updatedLink, purchase] = await prisma.$transaction([
    prisma.playerStore.update({
      where: { playerId_storeId: { playerId, storeId } },
      data: { 
        totalPoints: { decrement: product.priceInPoints },
        pendingUpgrade
      },
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

const pendingCashOrderSchema = z.object({
  storeId: z.string().min(1),
  productId: z.string().min(1),
});

playerRouter.post('/shop/pending-order', handleAsync(async (req: Request, res: Response) => {
  const { storeId, productId } = pendingCashOrderSchema.parse(req.body);
  const playerId = req.user!.id;

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.isActive || product.priceInDt == null) {
    throw new AppError(404, 'Product not found or cash price unavailable');
  }

  const tierConfig = await prisma.tierConfig.findUnique({ where: { storeId } });
  const cashbackPct = tierConfig?.shopCashbackPct ?? 5; // Default 5%

  // Example: 10 DT * (5/100) * 1000 pts/DT
  // pointsPerDt is usually 1000 in this context, but let's use config if available, else 1000
  const pointsPerDt = tierConfig?.pointsPerDt ?? 1000;
  
  // Calculate points to earn
  const pointsToEarn = Math.floor((product.priceInDt * (cashbackPct / 100)) * pointsPerDt);

  // Mark previous pending orders for this player+store as cancelled to avoid duplicates
  await prisma.pendingCashOrder.updateMany({
    where: { playerId, storeId, status: 'pending' },
    data: { status: 'cancelled' }
  });

  const order = await prisma.pendingCashOrder.create({
    data: {
      playerId,
      storeId,
      productId,
      amountDt: product.priceInDt,
      pointsToEarn,
      status: 'pending'
    }
  });

  res.status(201).json(order);
}));

playerRouter.get('/shop/pending-order-status/:id', handleAsync(async (req: Request, res: Response) => {
  const order = await prisma.pendingCashOrder.findUnique({
    where: { id: String(req.params.id) },
    select: { status: true, pointsToEarn: true }
  });
  
  if (!order) throw new AppError(404, 'Order not found');
  res.json(order);
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

playerRouter.get('/tournaments/single/:id', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);
  const playerId = req.user!.id;

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    include: {
      participants: {
        where: { playerId }
      }
    }
  });

  if (!tournament) throw new AppError(404, 'Tournament not found');

  const registrationStatus = tournament.participants[0] 
    ? tournament.participants[0].status 
    : 'unregistered';

  res.json({
    ...tournament,
    participants: undefined,
    registrationStatus
  });
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

  // Notify the store owner
  try {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true }
    });
    
    if (store?.ownerId) {
      const player = await prisma.player.findUnique({
        where: { id: playerId },
        select: { name: true, username: true }
      });
      
      const playerName = player?.name || 'Unknown';
      const playerUsername = player?.username || 'unknown';
      
      await sendPushNotification(
        store.ownerId,
        '🏆 New Tournament Registration',
        `${playerName} (@${playerUsername}) registered for "${tournament.name}".`,
        { type: 'tournament_registration', tournamentId, storeId }
      );
    }
  } catch (err) {
    console.error('Error sending tournament registration notification to owner:', err);
  }

  res.status(201).json(participant);
}));

playerRouter.get('/tournaments/:id/matches', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);

  const tournament = await prisma.tournament.findFirst({
    where: { id: tournamentId, isActive: true }
  });
  if (!tournament) throw new AppError(404, 'Tournament not found or inactive');

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
      } else {
        // Draw
        p1.points += 1;
        p2.points += 1;
      }
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

playerRouter.get('/tournaments/:id/standings', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);

  const tournament = await prisma.tournament.findFirst({
    where: { id: tournamentId, isActive: true }
  });
  if (!tournament) throw new AppError(404, 'Tournament not found or inactive');

  const standings = await computeStandingsInternal(prisma, tournamentId);
  res.json(standings);
}));

playerRouter.get('/tournaments/:id/participants', handleAsync(async (req: Request, res: Response) => {
  const tournamentId = String(req.params.id);

  const participants = await prisma.tournamentParticipant.findMany({
    where: { tournamentId, status: 'accepted' },
    include: {
      player: { select: { id: true, name: true, username: true, avatarUrl: true, avatarSeed: true } }
    },
    orderBy: { registeredAt: 'asc' }
  });
  res.json(participants);
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
    where: { id: (req as any).user!.id },
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
  const playerId = (req as any).user!.id;

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

// ─────────────────────────────────────────────
// MATCH SCHEDULING & CHAT ROOMS
// ─────────────────────────────────────────────

// GET /api/player/matches/:id - Fetch match room details
playerRouter.get('/matches/:id', handleAsync(async (req: Request, res: Response) => {
  const matchId = String(req.params.id);
  const playerId = req.user!.id;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      player1: { select: { id: true, username: true, name: true, avatarUrl: true, avatarSeed: true } },
      player2: { select: { id: true, username: true, name: true, avatarUrl: true, avatarSeed: true } },
      tournament: { select: { id: true, name: true, format: true, storeId: true, blockedSlots: true, schedulingRange: true } },
      messages: {
        orderBy: { createdAt: 'asc' }
      }
    }
  });

  if (!match) throw new AppError(404, 'Match not found');

  // Verify player is part of the match or is owner/admin
  const isParticipant = match.player1Id === playerId || match.player2Id === playerId;
  const isOwnerOrAdmin = req.user!.role === 'owner' || req.user!.role === 'admin';
  if (!isParticipant && !isOwnerOrAdmin) {
    throw new AppError(403, 'You are not a participant in this match');
  }

  // Fetch all other confirmed matches' scheduled times in the same store
  const confirmedStoreMatches = await prisma.match.findMany({
    where: {
      tournament: { storeId: match.tournament.storeId },
      scheduleStatus: 'confirmed',
      scheduledAt: { not: null },
      id: { not: matchId }
    },
    select: {
      scheduledAt: true
    }
  });

  const bookedSlots = confirmedStoreMatches.map(m => m.scheduledAt!.toISOString());

  res.json({
    ...match,
    bookedSlots
  });
}));

// POST /api/player/matches/:id/propose - Propose a schedule slot
playerRouter.post('/matches/:id/propose', handleAsync(async (req: Request, res: Response) => {
  const matchId = String(req.params.id);
  const playerId = req.user!.id;
  const { proposedAt } = z.object({
    proposedAt: z.string()
  }).parse(req.body);

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      player1: true,
      player2: true,
      tournament: true
    }
  });

  if (!match) throw new AppError(404, 'Match not found');
  if (match.player1Id !== playerId && match.player2Id !== playerId) {
    throw new AppError(403, 'You are not a participant in this match');
  }
  if (match.status === 'completed') {
    throw new AppError(400, 'Cannot schedule a completed match');
  }

  const dateValue = new Date(proposedAt);
  if (isNaN(dateValue.getTime())) {
    throw new AppError(400, 'Invalid proposal date/time');
  }

  // Collision check: Ensure no other match in the same store is confirmed for the exact same time
  const collision = await prisma.match.findFirst({
    where: {
      tournament: { storeId: match.tournament.storeId },
      scheduledAt: dateValue,
      scheduleStatus: 'confirmed',
      id: { not: matchId }
    }
  });

  if (collision) {
    throw new AppError(400, 'This time slot is already booked by another match in the store');
  }

  // Check if blocked by store owner
  if (match.tournament.blockedSlots) {
    const blockedSlots = JSON.parse(match.tournament.blockedSlots) as string[];
    if (blockedSlots.includes(dateValue.toISOString())) {
      throw new AppError(400, 'This time slot has been blocked by the store owner');
    }
  }

  // Update proposal
  const updated = await prisma.match.update({
    where: { id: matchId },
    data: {
      proposedAt: dateValue,
      proposedById: playerId,
      scheduleStatus: 'pending_approval'
    },
    include: {
      player1: { select: { id: true, name: true } },
      player2: { select: { id: true, name: true } }
    }
  });

  // Send push notification to opponent
  const opponentId = match.player1Id === playerId ? match.player2Id : match.player1Id;
  if (opponentId) {
    const senderName = match.player1Id === playerId ? match.player1?.name : match.player2?.name;
    const formattedDate = dateValue.toLocaleString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
    await sendPushNotification(
      opponentId,
      '⚔️ New Match Proposal',
      `@${senderName || 'Your opponent'} proposed a schedule: ${formattedDate}. Tap to accept or propose alternative.`,
      { type: 'match_proposal', matchId }
    );
  }

  res.json(updated);
}));

// POST /api/player/matches/:id/accept - Accept the proposed schedule slot
playerRouter.post('/matches/:id/accept', handleAsync(async (req: Request, res: Response) => {
  const matchId = String(req.params.id);
  const playerId = req.user!.id;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      player1: true,
      player2: true,
      tournament: {
        include: {
          store: true
        }
      }
    }
  });

  if (!match) throw new AppError(404, 'Match not found');
  if (match.player1Id !== playerId && match.player2Id !== playerId) {
    throw new AppError(403, 'You are not a participant in this match');
  }
  if (match.scheduleStatus !== 'pending_approval' || !match.proposedAt) {
    throw new AppError(400, 'No pending schedule proposal to accept');
  }
  if (match.proposedById === playerId) {
    throw new AppError(400, 'You cannot accept your own proposal');
  }

  // Collision check one last time before locking
  const collision = await prisma.match.findFirst({
    where: {
      tournament: { storeId: match.tournament.storeId },
      scheduledAt: match.proposedAt,
      scheduleStatus: 'confirmed',
      id: { not: matchId }
    }
  });

  if (collision) {
    throw new AppError(400, 'This time slot was just booked by another match. Please propose another time.');
  }

  // Check if blocked by store owner
  if (match.tournament.blockedSlots && match.proposedAt) {
    const blockedSlots = JSON.parse(match.tournament.blockedSlots) as string[];
    if (blockedSlots.includes(match.proposedAt.toISOString())) {
      throw new AppError(400, 'This time slot was recently blocked by the store owner. Please propose another time.');
    }
  }

  // Lock the slot
  const updated = await prisma.match.update({
    where: { id: matchId },
    data: {
      scheduledAt: match.proposedAt,
      proposedAt: null,
      proposedById: null,
      scheduleStatus: 'confirmed'
    },
    include: {
      player1: { select: { id: true, name: true } },
      player2: { select: { id: true, name: true } }
    }
  });

  // Notify both players & store owner
  const opponentId = match.player1Id === playerId ? match.player2Id : match.player1Id;
  const formattedDate = updated.scheduledAt!.toLocaleString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });

  if (opponentId) {
    await sendPushNotification(
      opponentId,
      '📅 Match Confirmed!',
      `Your match is locked for: ${formattedDate}. Ready up!`,
      { type: 'match_confirmed', matchId }
    );
  }
  await sendPushNotification(
    playerId,
    '📅 Match Confirmed!',
    `Your match is locked for: ${formattedDate}. Ready up!`,
    { type: 'match_confirmed', matchId }
  );

  const storeOwnerId = match.tournament.store.ownerId;
  if (storeOwnerId) {
    const p1Name = updated.player1?.name || match.player1?.name || 'TBD';
    const p2Name = updated.player2?.name || match.player2?.name || 'TBD';
    await sendPushNotification(
      storeOwnerId,
      '📅 Match Planifié',
      `Le match ${p1Name} vs ${p2Name} est planifié pour : ${formattedDate}.`,
      { type: 'match_confirmed', matchId, tournamentId: match.tournamentId }
    );
  }

  res.json(updated);
}));

// POST /api/player/matches/:id/chat - Send a chat message to opponent
playerRouter.post('/matches/:id/chat', handleAsync(async (req: Request, res: Response) => {
  const matchId = String(req.params.id);
  const playerId = req.user!.id;
  const { text } = z.object({
    text: z.string().min(1)
  }).parse(req.body);

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { player1: true, player2: true }
  });

  if (!match) throw new AppError(404, 'Match not found');
  if (match.player1Id !== playerId && match.player2Id !== playerId) {
    throw new AppError(403, 'You are not a participant in this match');
  }

  // Create message
  const msg = await prisma.matchMessage.create({
    data: {
      matchId,
      senderId: playerId,
      text
    }
  });

  // Send push notification to opponent
  const opponentId = match.player1Id === playerId ? match.player2Id : match.player1Id;
  if (opponentId) {
    const senderName = match.player1Id === playerId ? match.player1?.name : match.player2?.name;
    await sendPushNotification(
      opponentId,
      `💬 Message from @${senderName || 'Opponent'}`,
      text.length > 50 ? `${text.slice(0, 50)}...` : text,
      { type: 'match_message', matchId }
    );
  }

  res.status(201).json(msg);
}));

// ─────────────────────────────────────────────
// NOTIFICATIONS API FOR PLAYERS
// ─────────────────────────────────────────────

playerRouter.get('/notifications', handleAsync(async (req: Request, res: Response) => {
  const playerId = req.user!.id;
  const notifications = await prisma.notification.findMany({
    where: { playerId },
    orderBy: { createdAt: 'desc' },
  });
  res.json(notifications);
}));

playerRouter.put('/notifications/read-all', handleAsync(async (req: Request, res: Response) => {
  const playerId = req.user!.id;
  const result = await prisma.notification.updateMany({
    where: { playerId, isRead: false },
    data: { isRead: true }
  });
  res.json({ success: true, count: result.count });
}));

playerRouter.put('/notifications/:id/read', handleAsync(async (req: Request, res: Response) => {
  const playerId = req.user!.id;
  const id = String(req.params.id);
  const notification = await prisma.notification.update({
    where: { id, playerId },
    data: { isRead: true }
  });
  res.json(notification);
}));

playerRouter.delete('/notifications/:id', handleAsync(async (req: Request, res: Response) => {
  const playerId = req.user!.id;
  const id = String(req.params.id);
  await prisma.notification.delete({
    where: { id, playerId }
  });
  res.json({ success: true });
}));

