import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { ownerRouter } from './routes/owner';
import { playerRouter } from './routes/player';
import { errorHandler } from './middleware/errorHandler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: 'NEO Backend', timestamp: new Date().toISOString() });
});

app.get('/api/app-version', (_req, res) => {
  res.json({
    android: {
      latestVersion: process.env.ANDROID_LATEST_VERSION || '1.1.2',
      latestVersionCode: Number(process.env.ANDROID_LATEST_VERSION_CODE || 12),
      minimumVersion: process.env.ANDROID_MINIMUM_VERSION || '1.1.2',
      minimumVersionCode: Number(process.env.ANDROID_MINIMUM_VERSION_CODE || 12),
      storeUrl: process.env.ANDROID_STORE_URL || 'https://play.google.com/store/apps/details?id=com.racep.neoapp',
    },
    ios: {
      latestVersion: process.env.IOS_LATEST_VERSION || '1.1.2',
      latestBuildNumber: Number(process.env.IOS_LATEST_BUILD_NUMBER || 12),
      minimumVersion: process.env.IOS_MINIMUM_VERSION || '1.1.2',
      minimumBuildNumber: Number(process.env.IOS_MINIMUM_BUILD_NUMBER || 12),
      storeUrl: process.env.IOS_STORE_URL || '',
    },
  });
});

// Routes
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/owner', ownerRouter);
app.use('/api/player', playerRouter);

// Global error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🎮 NEO Backend running on port ${PORT}`);
});

export default app;
