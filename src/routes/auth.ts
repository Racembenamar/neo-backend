import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AppError, handleAsync } from '../middleware/errorHandler';
import { normalizeWorkerPermissions } from '../lib/workerPermissions';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const playerRegisterSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  newPassword: z.string().min(6),
});

const googleAuthSchema = z.object({
  idToken: z.string().min(20),
});

const resetCooldown = new Map<string, number>();

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function hashCode(code: string) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function createPlayerToken(player: any, role: 'player' | 'owner', storeId?: string) {
  return jwt.sign(
    { id: player.id, role, storeId },
    process.env.JWT_SECRET!,
    { expiresIn: '30d' }
  );
}

function playerAuthResponse(player: any, role: 'player' | 'owner' = 'player', storeId?: string) {
  return {
    id: player.id,
    username: player.username,
    name: player.name,
    email: player.email,
    emailVerified: player.emailVerified,
    phone: player.phone,
    avatarSeed: player.avatarSeed,
    avatarUrl: player.avatarUrl,
    role,
    storeId,
  };
}

async function sendPasswordResetEmail(email: string, code: string) {
  const appName = process.env.APP_NAME || 'NEO';
  const subject = `${appName} password reset code`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>${appName} password reset</h2>
      <p>Use this code to reset your password:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>
      <p>This code expires in 15 minutes. If you did not request it, you can ignore this email.</p>
    </div>
  `;
  const text = `${appName} password reset code: ${code}. This code expires in 15 minutes.`;

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new AppError(500, 'Gmail SMTP is not configured');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || `"${appName}" <${process.env.GMAIL_USER}>`,
      to: email,
      subject,
      html,
      text,
    });
  } catch (err: any) {
    console.error('[AUTH] Gmail reset email failed:', err?.message || err);
    throw new AppError(502, 'Failed to send reset email through Gmail');
  }
}

async function verifyGoogleIdToken(idToken: string) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) {
    throw new AppError(401, 'Invalid Google token');
  }

  const payload = await response.json() as any;
  const allowedClientIds = [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
  ].filter(Boolean);

  if (allowedClientIds.length > 0 && !allowedClientIds.includes(payload.aud)) {
    throw new AppError(401, 'Google token audience is not allowed');
  }

  if (!payload.email || payload.email_verified !== 'true') {
    throw new AppError(400, 'Google account email is not verified');
  }

  return {
    googleId: String(payload.sub),
    email: normalizeEmail(String(payload.email)),
    name: String(payload.name || payload.email.split('@')[0]),
    picture: payload.picture ? String(payload.picture) : undefined,
  };
}

async function uniqueGoogleUsername(email: string) {
  const base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 18) || 'player';
  let candidate = base;
  let suffix = 0;

  while (await prisma.player.findUnique({ where: { username: candidate } })) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }

  return candidate;
}

// POST /api/auth/register
authRouter.post('/register', handleAsync(async (req: Request, res: Response) => {
  const { username, password, name, phone } = playerRegisterSchema.parse(req.body);
  const email = normalizeEmail(req.body.email);

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
  const existingWorker = await prisma.storeWorker.findUnique({ where: { username } });
  if (existingWorker) {
    res.status(400).json({ error: 'Username already exists' });
    return;
  }

  const existingEmail = await prisma.player.findUnique({ where: { email } });
  if (existingEmail) {
    res.status(400).json({ error: 'Email already exists' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const player = await prisma.player.create({
    data: { username, passwordHash, name, email, phone, authProvider: 'password' }
  });

  const token = createPlayerToken(player, 'player');

  res.status(201).json({
    token,
    user: playerAuthResponse(player),
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
    } else {
      const worker = await prisma.storeWorker.findUnique({
        where: { username },
      });
      if (worker) {
        if (!worker.isActive) {
          res.status(403).json({ error: 'Worker account is disabled' });
          return;
        }
        user = worker;
        role = 'worker';
        storeId = worker.storeId;
      }
    }
  }

  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  if (!user.passwordHash) {
    res.status(401).json({ error: 'Please sign in with Google' });
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
      email: user.email,
      emailVerified: user.emailVerified,
      avatarSeed: user.avatarSeed,
      avatarUrl: user.avatarUrl,
      role,
      storeId,
      permissions: role === 'worker' ? normalizeWorkerPermissions(user.permissions) : undefined,
    },
  });
}));

// POST /api/auth/google - sign in or create a player with Google
authRouter.post('/google', handleAsync(async (req: Request, res: Response) => {
  const { idToken } = googleAuthSchema.parse(req.body);
  const googleProfile = await verifyGoogleIdToken(idToken);

  let player = await prisma.player.findFirst({
    where: {
      OR: [
        { googleId: googleProfile.googleId },
        { email: googleProfile.email },
      ],
    },
    include: { ownedStore: true },
  });

  if (player) {
    player = await prisma.player.update({
      where: { id: player.id },
      data: {
        googleId: player.googleId || googleProfile.googleId,
        email: player.email || googleProfile.email,
        emailVerified: true,
        authProvider: player.passwordHash ? 'both' : 'google',
        avatarUrl: player.avatarUrl || googleProfile.picture,
      },
      include: { ownedStore: true },
    });
  } else {
    player = await prisma.player.create({
      data: {
        username: await uniqueGoogleUsername(googleProfile.email),
        passwordHash: null,
        name: googleProfile.name,
        email: googleProfile.email,
        emailVerified: true,
        googleId: googleProfile.googleId,
        authProvider: 'google',
        avatarUrl: googleProfile.picture,
      },
      include: { ownedStore: true },
    });
  }

  const role = player.ownedStore ? 'owner' : 'player';
  const storeId = player.ownedStore?.id;
  const token = createPlayerToken(player, role, storeId);

  res.json({
    token,
    user: playerAuthResponse(player, role, storeId),
  });
}));

// POST /api/auth/forgot-password
authRouter.post('/forgot-password', handleAsync(async (req: Request, res: Response) => {
  const { email: rawEmail } = forgotPasswordSchema.parse(req.body);
  const email = normalizeEmail(rawEmail);
  const genericResponse = { success: true, message: 'If an account exists, reset instructions were sent.' };

  const now = Date.now();
  const cooldownUntil = resetCooldown.get(email) || 0;
  if (cooldownUntil > now) {
    res.json(genericResponse);
    return;
  }
  resetCooldown.set(email, now + 60_000);

  const player = await prisma.player.findUnique({ where: { email } });
  if (!player) {
    res.json(genericResponse);
    return;
  }

  const code = crypto.randomInt(100000, 1000000).toString();
  await prisma.player.update({
    where: { id: player.id },
    data: {
      passwordResetCodeHash: hashCode(code),
      passwordResetExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });

  try {
    await sendPasswordResetEmail(email, code);
  } catch (err) {
    resetCooldown.delete(email);
    throw err;
  }

  res.json(genericResponse);
}));

// POST /api/auth/reset-password
authRouter.post('/reset-password', handleAsync(async (req: Request, res: Response) => {
  const { email: rawEmail, code, newPassword } = resetPasswordSchema.parse(req.body);
  const email = normalizeEmail(rawEmail);

  const player = await prisma.player.findUnique({ where: { email } });
  if (!player || !player.passwordResetCodeHash || !player.passwordResetExpiresAt) {
    throw new AppError(400, 'Invalid or expired reset code');
  }

  if (player.passwordResetExpiresAt.getTime() < Date.now()) {
    throw new AppError(400, 'Invalid or expired reset code');
  }

  if (player.passwordResetCodeHash !== hashCode(code)) {
    throw new AppError(400, 'Invalid or expired reset code');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.player.update({
    where: { id: player.id },
    data: {
      passwordHash,
      authProvider: player.googleId ? 'both' : 'password',
      passwordResetCodeHash: null,
      passwordResetExpiresAt: null,
    },
  });

  res.json({ success: true });
}));

// GET /api/auth/me
authRouter.get('/me', requireAuth, handleAsync(async (req: Request, res: Response) => {
  const { id, role } = req.user!;

  if (role === 'admin') {
    const admin = await prisma.admin.findUnique({ where: { id } });
    res.json({ id: admin!.id, username: admin!.username, role });
    return;
  }

  if (role === 'worker') {
    const worker = await prisma.storeWorker.findUnique({ where: { id } });
    if (!worker || !worker.isActive) {
      res.status(401).json({ error: 'Worker account is disabled or no longer exists' });
      return;
    }
    res.json({
      id: worker.id,
      username: worker.username,
      name: worker.name,
      phone: worker.phone,
      role,
      storeId: worker.storeId,
      permissions: normalizeWorkerPermissions(worker.permissions),
    });
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
    email: player!.email,
    emailVerified: player!.emailVerified,
    phone: player!.phone,
    avatarSeed: player!.avatarSeed,
    avatarUrl: player!.avatarUrl,
    role,
    storeId: player!.ownedStore?.id,
    stores: player!.storeLinks,
  });
}));
