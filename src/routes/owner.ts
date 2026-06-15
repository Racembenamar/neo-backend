import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
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

  res.json({
    player,
    totalPoints: link?.totalPoints ?? 0,
    tier: link?.tier ?? 1,
    isFirstVisit: !link,
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
  format: z.enum(['single_elimination', 'group_knockout', 'group_points']).optional(),
  groupSize: z.number().int().positive().nullable().optional(),
  advancingCount: z.number().int().positive().nullable().optional(),
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
    where: { id: matchId, tournamentId }
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
          await prisma.match.update({
            where: { id: nextMatch.id },
            data: isP1 ? { player1Id: winnerId } : { player2Id: winnerId }
          });
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
    } else {
      const nextRound = match.round + 1;
      const nextIndex = Math.floor(match.matchIndex / 2);
      const isP1 = match.matchIndex % 2 === 0;
      const nextMatch = await prisma.match.findFirst({
        where: { tournamentId, round: nextRound, matchIndex: nextIndex, group: null }
      });
      if (nextMatch) {
        await prisma.match.update({
          where: { id: nextMatch.id },
          data: isP1 ? { player1Id: winnerId } : { player2Id: winnerId }
        });
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

  // 3. Send using Expo (Dynamic import for ESM compatibility)
  const { Expo } = await import('expo-server-sdk');
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


