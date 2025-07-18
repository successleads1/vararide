// server.ts – Express + Socket.io + Telegram bot backend
/******************************************************************
 *  server.ts – Express + Socket.io + Telegram bot backend
 *  --------------------------------------------------------------
 *  • Production  → uses TELEGRAM_WEBHOOK_URL & RIDER_WEBHOOK_URL
 *  • Development → if DEV_TUNNEL === "localtunnel", spins up an
 *                  HTTPS tunnel with the localtunnel package
 ******************************************************************/

import express          from 'express';
import { createServer } from 'http';
import { Server as IO } from 'socket.io';
import fetch            from 'node-fetch';
import 'dotenv/config';

import { connectDB }      from './db.js';
import { telegramRouter } from './routes/telegram.js';
import { bot, sendApprovalLink } from './bot.js';
import { RiderPort }      from './riderPort.js';
import { Driver }         from './models/Driver.js';

/* -------------------------------------------------------------- */
/* 0 ▸  Env + sanity checks                                       */
/* -------------------------------------------------------------- */
const {
  PORT = '4000',
  PUBLIC_SOCKET_ORIGIN = '*',
  NODE_ENV,
  DEV_TUNNEL,
  TELEGRAM_WEBHOOK_URL,
  RIDER_WEBHOOK_URL,
  MONGODB_URI
} = process.env;

console.log('🟢 Starting server on PORT =', PORT);

if (!MONGODB_URI) {
  console.error('❌  MONGODB_URI missing');
  process.exit(1);
}
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌  TELEGRAM_BOT_TOKEN missing');
  process.exit(1);
}
if (NODE_ENV === 'production') {
  if (!TELEGRAM_WEBHOOK_URL) {
    console.error('❌  TELEGRAM_WEBHOOK_URL missing');
    process.exit(1);
  }
  if (!RIDER_WEBHOOK_URL) {
    console.error('❌  RIDER_WEBHOOK_URL missing');
    process.exit(1);
  }
}

/* -------------------------------------------------------------- */
/* 1 ▸  Helper – open localtunnel only while developing           */
/* -------------------------------------------------------------- */
async function openTunnel(maxTries = 4) {
  if (NODE_ENV === 'production' || DEV_TUNNEL !== 'localtunnel') return null;
  const { default: localtunnel } = await import('localtunnel');
  const optsBase = { port: +PORT, subdomain: process.env.LT_SUBDOMAIN };
  const hosts = ['https://loca.lt', 'https://localtunnel.me'];

  for (const host of hosts) {
    for (let i = 1; i <= maxTries; i++) {
      try {
        console.log(`🌍  localtunnel (${host}) attempt ${i} …`);
        const tunnel = await localtunnel({ ...optsBase, host });
        tunnel.on('error', e => console.warn('localtunnel socket error →', e.message));
        console.log('🔗  localtunnel url:', tunnel.url);
        return tunnel;
      } catch (err: any) {
        console.error(`   ✖︎ failed (${err?.message ?? err})`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------- */
/* 2 ▸  Bootstrap                                                 */
/* -------------------------------------------------------------- */
(async () => {
  /* MongoDB */
  await connectDB();
  console.log('✅  MongoDB connected');

  /* Express */
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Driver bot updates
  app.post('/telegram/webhook',
    express.json({ limit: '10mb' }),
    telegramRouter
  );

  // Rider bot updates
  app.post('/telegram/rider-webhook',
    express.json({ limit: '10mb' }),
    async (req, res) => {
      try {
        await RiderPort.processUpdate(req.body);
        res.sendStatus(200);
      } catch (err) {
        console.error('rider‑webhook failed:', err);
        res.sendStatus(500);
      }
    }
  );

  // Admin helper – push dashboard link when driver approved
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
      console.error('notify‑approval failed:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  /* HTTP + Socket.io */
  const http = createServer(app);
  const io   = new IO(http, { cors: { origin: PUBLIC_SOCKET_ORIGIN } });

  io.on('connection', socket => {
    console.log('⚡ Socket connected:', socket.id);
    socket.on('disconnect', () => console.log('⚡ Socket disconnected:', socket.id));
  });

  // ✅ THIS LINE ENSURES YOUR APP BINDS TO A PORT
  http.listen(Number(PORT), () =>
    console.log(`> backend running on http://localhost:${PORT}`)
  );

  /* -------------------------------------------------------------- */
  /* 3 ▸ Telegram webhook registration                             */
  /* -------------------------------------------------------------- */

  if (NODE_ENV === 'production') {
    try {
      console.log('→ setting production webhooks…');
      await bot.setWebHook(TELEGRAM_WEBHOOK_URL!);
      await RiderPort.setWebHook(RIDER_WEBHOOK_URL!);
      console.log('✅ production webhooks set');
    } catch (err) {
      console.error('❌ setWebhook (prod) failed:', err);
    }
  }

  if (NODE_ENV !== 'production') {
    const tunnel = await openTunnel();
    if (tunnel) {
      const driverUrl = `${tunnel.url}/telegram/webhook`;
      const riderUrl  = `${tunnel.url}/telegram/rider-webhook`;
      try {
        await bot.setWebHook(driverUrl);
        await RiderPort.setWebHook(riderUrl);
        console.log('→ setWebhook (dev):', { driverUrl, riderUrl });
      } catch (err) {
        console.error('❌ setWebhook (dev) failed:', err);
      }

      const cleanup = async () => {
        console.log('\n↩  Closing localtunnel…');
        try { await tunnel.close(); } catch {}
        process.exit(0);
      };
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
    } else {
      console.warn('‼️  Could not establish localtunnel – webhooks won’t auto-register.');
    }
  }
})();
