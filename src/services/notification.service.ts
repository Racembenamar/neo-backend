import { Expo } from 'expo-server-sdk';
import { prisma } from '../lib/prisma';

const expo = new Expo();

/**
 * Sends a push notification to a single player on all their registered device tokens.
 */
export async function sendPushNotification(
  playerId: string,
  title: string,
  body: string,
  data?: any
): Promise<void> {
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
      title,
      body,
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
 * Sends a push notification to multiple players.
 */
export async function sendPushNotificationToMultiple(
  playerIds: string[],
  title: string,
  body: string,
  data?: any
): Promise<void> {
  if (playerIds.length === 0) return;

  const deviceTokens = await prisma.deviceToken.findMany({
    where: { playerId: { in: playerIds } }
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
      title,
      body,
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
