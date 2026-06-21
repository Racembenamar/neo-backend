import { Expo } from 'expo-server-sdk';
import { prisma } from '../lib/prisma';
import { normalizeLanguage, translateText } from '../lib/i18n';

const expo = new Expo();

/**
 * Resolves storeId based on data payload or player's store membership.
 */
async function resolveStoreId(playerId: string | null, data?: any): Promise<string | null> {
  if (data?.storeId) return data.storeId;
  
  if (data?.matchId) {
    const match = await prisma.match.findUnique({
      where: { id: data.matchId },
      select: { tournament: { select: { storeId: true } } }
    });
    if (match?.tournament.storeId) return match.tournament.storeId;
  }
  
  if (data?.tournamentId) {
    const tournament = await prisma.tournament.findUnique({
      where: { id: data.tournamentId },
      select: { storeId: true }
    });
    if (tournament?.storeId) return tournament.storeId;
  }
  
  if (playerId) {
    const link = await prisma.playerStore.findFirst({
      where: { playerId },
      select: { storeId: true }
    });
    if (link?.storeId) return link.storeId;
  }
  
  return null;
}

/**
 * Sends a push notification to a single player on all their registered device tokens and logs it in the DB.
 */
export async function sendPushNotification(
  playerId: string,
  title: string,
  body: string,
  data?: any
): Promise<void> {
  // 1. Save to DB for historical in-app feed
  try {
    const storeId = await resolveStoreId(playerId, data);
    if (storeId) {
      // Check if player has muted notifications for this store
      const link = await prisma.playerStore.findUnique({
        where: { playerId_storeId: { playerId, storeId } }
      });
      if (link?.notificationsMuted) {
        console.log(`[Notification Service] Store ${storeId} is muted for player ${playerId}. Skipping notification.`);
        return;
      }

      await prisma.notification.create({
        data: {
          storeId,
          playerId,
          title,
          body,
          type: data?.type || null,
          data: data ? JSON.stringify(data) : null,
          isRead: false
        }
      });
    }
  } catch (error) {
    console.error('Error saving notification to DB:', error);
  }

  // 2. Fetch tokens and send push alert
  const deviceTokens = await prisma.deviceToken.findMany({
    where: { playerId }
  });

  if (deviceTokens.length === 0) return;

  const messages = [];
  for (const dt of deviceTokens) {
    if (!Expo.isExpoPushToken(dt.token)) {
      continue;
    }
    messages.push({
      to: dt.token,
      sound: 'default' as const,
      title: translateText(title, normalizeLanguage((dt as any).language)),
      body: translateText(body, normalizeLanguage((dt as any).language)),
      data,
    });
  }

  if (messages.length === 0) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (error) {
      console.error('Error sending push notification chunk:', error);
    }
  }
}

/**
 * Sends a push notification to multiple players and logs it in the DB.
 */
export async function sendPushNotificationToMultiple(
  playerIds: string[],
  title: string,
  body: string,
  data?: any
): Promise<void> {
  if (playerIds.length === 0) return;

  let activePlayerIds = playerIds;

  // 1. Save to DB for all recipient players
  try {
    const storeId = await resolveStoreId(playerIds[0], data);
    if (storeId) {
      // Filter out players who have muted notifications for this store
      const mutedLinks = await prisma.playerStore.findMany({
        where: {
          storeId,
          playerId: { in: playerIds },
          notificationsMuted: true
        },
        select: { playerId: true }
      });
      const mutedPlayerIds = new Set(mutedLinks.map(l => l.playerId));
      activePlayerIds = playerIds.filter(id => !mutedPlayerIds.has(id));

      if (activePlayerIds.length > 0) {
        await prisma.notification.createMany({
          data: activePlayerIds.map(playerId => ({
            storeId,
            playerId,
            title,
            body,
            type: data?.type || null,
            data: data ? JSON.stringify(data) : null,
            isRead: false
          }))
        });
      }
    }
  } catch (error) {
    console.error('Error saving multiple notifications to DB:', error);
  }

  if (activePlayerIds.length === 0) return;

  // 2. Fetch tokens and send push alerts
  const deviceTokens = await prisma.deviceToken.findMany({
    where: { playerId: { in: activePlayerIds } }
  });

  if (deviceTokens.length === 0) return;

  const messages = [];
  for (const dt of deviceTokens) {
    if (!Expo.isExpoPushToken(dt.token)) {
      continue;
    }
    messages.push({
      to: dt.token,
      sound: 'default' as const,
      title: translateText(title, normalizeLanguage((dt as any).language)),
      body: translateText(body, normalizeLanguage((dt as any).language)),
      data,
    });
  }

  if (messages.length === 0) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (error) {
      console.error('Error sending push notification chunk:', error);
    }
  }
}
