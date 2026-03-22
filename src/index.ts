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
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: 'NEO Backend', timestamp: new Date().toISOString() });
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
