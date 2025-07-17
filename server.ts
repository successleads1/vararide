/******************************************************************
 *  server.ts – Express + Socket.io + Telegram bot backend
 *  --------------------------------------------------------------
 *  • Production  → uses TELEGRAM_WEBHOOK_URL you set in .env
 *  • Development → if DEV_TUNNEL === "localtunnel", spins up an
 *                  HTTPS tunnel with the localtunnel package
 ******************************************************************/

import express            from 'express';
import { createServer }   from 'http';
import { Server as IO }   from 'socket.io';
import localtunnel        from 'localtunnel';
import fetch              from 'node-fetch';
import 'dotenv/config';

import { connectDB }                from './db.js';
import { telegramRouter }           from './routes/telegram.js';
import { bot, sendApprovalLink }    from './bot.js';
import { Driver }                   from './models/Driver.js';

/* ------------------------------------------------------------------ */
/* 0 ▸  Env + sanity checks                                            */
/* ------------------------------------------------------------------ */
const {
  PORT                 = '4000',
  PUBLIC_SOCKET_ORIGIN = '*',
  NODE_ENV,
  DEV_TUNNEL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_URL,
  MONGODB_URI
} = process.env;

if (!MONGODB_URI)        { console.error('❌  MONGODB_URI missing');        process.exit(1); }
if (!TELEGRAM_BOT_TOKEN) { console.error('❌  TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (NODE_ENV === 'production' && !TELEGRAM_WEBHOOK_URL) {
  console.error('❌  TELEGRAM_WEBHOOK_URL missing in production'); process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 1 ▸  Helper – open localtunnel with retry & host fallback           */
/* ------------------------------------------------------------------ */
async function openTunnel(maxTries = 4): Promise<localtunnel.Tunnel | null> {
  const optsBase: localtunnel.Options = {
    port: +PORT,
    subdomain: process.env.LT_SUBDOMAIN        // optional custom name
  };
  // try modern infra (.loca.lt) first, then legacy
  const hosts = ['https://loca.lt', 'https://localtunnel.me'];

  for (const host of hosts) {
    for (let i = 1; i <= maxTries; i++) {
      try {
        console.log(`🌍  localtunnel (${host}) attempt ${i} …`);
        const tunnel = await localtunnel({ ...optsBase, host });

        /* swallow async socket errors so they don’t crash Node */
        tunnel.on('error', (e) =>
          console.warn('localtunnel socket error →', e.message)
        );

        console.log('🔗  localtunnel url:', tunnel.url);
        return tunnel;                                    // ✅ success
      } catch (err) {
        console.error(
          `   ✖︎ failed (${err instanceof Error ? err.message : err})`
        );
        await new Promise(r => setTimeout(r, 2_000));     // wait 2 s
      }
    }
  }
  return null;                                            // all attempts failed
}

/* ------------------------------------------------------------------ */
/* 2 ▸  Bootstrap                                                     */
/* ------------------------------------------------------------------ */
(async () => {
  /* ---------- MongoDB --------------------------------------------- */
  await connectDB();
  console.log('✅  MongoDB connected');

  /* ---------- Express --------------------------------------------- */
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Telegram update endpoint
  app.use('/telegram/webhook', telegramRouter);

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

  /* ---------- HTTP + Socket.io ------------------------------------ */
  const http = createServer(app);
  const io   = new IO(http, { cors: { origin: PUBLIC_SOCKET_ORIGIN } });

  http.listen(+PORT, () =>
    console.log(`> backend running on http://localhost:${PORT}`)
  );

  /* ----------------------------------------------------------------
   *  3 ▸  Telegram webhook registration
   * ----------------------------------------------------------------*/

  // ── PRODUCTION – use your fixed Vercel URL -----------------------
  if (NODE_ENV === 'production') {
    try {
      const resp = await bot.setWebHook(TELEGRAM_WEBHOOK_URL!);
      console.log('→ setWebhook (prod) →', resp);
    } catch (err) {
      console.error('❌  setWebhook (prod) failed:', err);
    }
  }

  // ── DEVELOPMENT – auto‑open localtunnel if requested ------------
  if (NODE_ENV !== 'production' && DEV_TUNNEL === 'localtunnel') {
    const tunnel = await openTunnel();
    if (tunnel) {
      try {
        const resp = await bot.setWebHook(`${tunnel.url}/telegram/webhook`);
        console.log('→ setWebhook (dev) →', resp);
      } catch (err) {
        console.error('setWebhook (dev) failed:', err);
      }

      // graceful shutdown
      const close = async () => {
        console.log('\n↩  Closing localtunnel…');
        try { await tunnel.close(); } catch {/* ignore */}
        process.exit(0);
      };
      process.once('SIGINT',  close);
      process.once('SIGTERM', close);
    } else {
      console.warn('‼️  Could not establish localtunnel – bot stays silent until you /start it manually.');
    }
  }
})();
