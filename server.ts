import express            from 'express';
import { createServer }   from 'http';
import { Server as IO }   from 'socket.io';
import fetch              from 'node-fetch';
import 'dotenv/config';

import { connectDB }                from './db.js';
import { telegramRouter }           from './routes/telegram.js';
import { bot, sendApprovalLink }    from './bot.js';
import { Driver }                   from './models/Driver.js';

const {
  PORT                 = '4000',
  PUBLIC_SOCKET_ORIGIN = '*',
  NODE_ENV,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_URL,
  MONGODB_URI
} = process.env;

if (!MONGODB_URI)        { console.error('❌  MONGODB_URI missing');        process.exit(1); }
if (!TELEGRAM_BOT_TOKEN) { console.error('❌  TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (NODE_ENV === 'production' && !TELEGRAM_WEBHOOK_URL) {
  console.error('❌  TELEGRAM_WEBHOOK_URL missing in production'); process.exit(1);
}

(async () => {
  await connectDB();
  console.log('✅  MongoDB connected');

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Telegram update endpoint
  app.use('/telegram/webhook', telegramRouter);

  // Admin – push dashboard link when driver approved
  app.post('/admin/notify-approval', async (req, res) => {
    try {
      const { driverId } = req.body;
      if (!driverId) return res.status(400).json({ error: 'driverId is required' });

      const d = await Driver.findById(driverId);
      if (!d) return res.status(404).json({ error: 'Driver not found' });

      d.status = 'approved';
      await d.save();
      await sendApprovalLink(d);
      res.json({ success: true });
    } catch (err) {
      console.error('notify-approval failed:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  const http = createServer(app);
  const io   = new IO(http, { cors: { origin: PUBLIC_SOCKET_ORIGIN } });

  http.listen(+PORT, () =>
    console.log(`> backend running on http://localhost:${PORT}`)
  );

  // ── Telegram webhook registration ────────────────────────────
  if (NODE_ENV === 'production') {
    try {
      const resp = await bot.setWebHook(TELEGRAM_WEBHOOK_URL!);
      console.log('→ setWebhook (prod) →', resp);
    } catch (err) {
      console.error('❌  setWebhook (prod) failed:', err);
    }
  } else {
    console.log('⚠️  Skipping webhook setup in development (no tunnel).');
  }
})();
