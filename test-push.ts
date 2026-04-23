import { Expo } from 'expo-server-sdk';
const expo = new Expo();
async function test() {
  const token = 'ExponentPushToken[t3Mq95ND6YChG824aXEsFb]';
  if (!Expo.isExpoPushToken(token)) {
    console.error('Invalid token');
    return;
  }
  try {
    const receipts = await expo.sendPushNotificationsAsync([{
      to: token,
      sound: 'default',
      title: 'TEST NOTIFICATION',
      body: 'If you see this, push notifications are working perfectly!'
    }]);
    console.log('RECEIPTS:', receipts);
  } catch (e) {
    console.error('ERROR:', e);
  }
}
test();
