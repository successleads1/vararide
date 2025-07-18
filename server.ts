import express from 'express';
import { createServer } from 'http';
import { Server as IO } from 'socket.io';
import 'dotenv/config';
import ejs from 'ejs';
import path from 'path';
import { connectDB } from './db.js';
import { telegramRouter } from './routes/telegram.js';
import { bot, sendApprovalLink } from './bot.js';
import { RiderPort } from './riderPort.js';
import { Driver } from './models/Driver.js';

const {
  PORT = '4000',
  PUBLIC_SOCKET_ORIGIN = '*',
  NODE_ENV,
  DEV_TUNNEL,
  TELEGRAM_WEBHOOK_URL,
  RIDER_WEBHOOK_URL,
  MONGODB_URI,
  APP_BASE_URL,
} = process.env;

if (!MONGODB_URI)    throw new Error('MONGODB_URI missing');
if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN missing');

console.log(`🟢 Starting server in ${NODE_ENV} mode on PORT = ${PORT}`);

// current __dirname hack for ESM:
const __dirname = path.dirname(new URL(import.meta.url).pathname);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true })); // for form posts

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Telegram webhooks ───────────────────────────────────────────
app.post('/telegram/webhook',
  express.json({ limit: '10mb' }),
  telegramRouter
);

app.post('/telegram/rider-webhook',
  express.json({ limit: '10mb' }),
  async (req, res) => {
    try {
      await RiderPort.processUpdate(req.body);
      res.sendStatus(200);
    } catch (err) {
      console.error('rider-webhook error:', err);
      res.sendStatus(500);
    }
  }
);

// ── Generate a mock payment link ────────────────────────────────
app.post('/generate-payment-link', (req, res) => {
  const { chatId, amount } = req.body;
  if (!chatId || typeof amount !== 'number') {
    return res.status(400).json({ error: 'chatId and amount (number) required' });
  }
  // In real life you’d call PayFast here and get a URL back.
  // For mock, point to our own `/payment` page with query params.
  const paymentLink = `${APP_BASE_URL}/payment?chatId=${encodeURIComponent(chatId)}&amount=${amount}`;
  return res.json({ paymentLink });
});

// ── Render mock payment page ────────────────────────────────────
app.get('/payment', (req, res) => {
  const { chatId, amount } = req.query;
  if (!chatId || !amount) {
    return res.status(400).send('Missing chatId or amount');
  }
  res.render('payment', { chatId, amount });
});

// ── Handle mock‑pay form submission ─────────────────────────────
app.post('/mock-pay', async (req, res) => {
  const { chatId, amount, method } = req.body;
  if (!chatId || !amount || !method) {
    return res.status(400).send('Missing fields');
  }
  // Notify the user in Telegram that payment was received:
  await bot.sendMessage(
    chatId,
    `✅ Payment of ${amount} ZAR received via *${method}*. Thank you!`,
    { parse_mode: 'Markdown' }
  );
  res.render('thankyou', { amount, method });
});

// ── Socket.io + HTTP server ────────────────────────────────────
;(async () => {
  await connectDB();
  console.log('✅ MongoDB connected');

  const http = createServer(app);
  const io = new IO(http, { cors: { origin: PUBLIC_SOCKET_ORIGIN } });
  io.on('connection', sock => console.log('⚡ Socket connected:', sock.id));

  http.listen(+PORT, () =>
    console.log(`> backend running on http://localhost:${PORT}`)
  );

  // ── Webhook registration
  if (NODE_ENV === 'production') {
    // Delete the existing webhook first before setting a new one
    try {
      const info = await bot.getWebHookInfo();
      if (info.url) {
        console.log('→ Deleting existing driver webhook…');
        await bot.deleteWebHook();
      }
      console.log('→ setting production driver webhook…');
      await bot.setWebHook(TELEGRAM_WEBHOOK_URL!);
    } catch (err: any) {
      console.error('❌ driver setWebHook error:', err);
    }

    // Rider bot
    try {
      const info = await bot.getWebHookInfo(); // or riderBot.getWebHookInfo() if separate
      if (info.url) {
        console.log('→ Deleting existing rider webhook…');
        await RiderPort.setWebHook('');
      }
      console.log('→ setting production rider webhook…');
      await RiderPort.setWebHook(RIDER_WEBHOOK_URL!);
    } catch (err: any) {
      console.error('❌ rider setWebHook error:', err);
    }
  } else {
    // ── Development: open localtunnel & register dev webhooks
    const tunnel = await openTunnel();
    if (tunnel) {
      const driverUrl = `${tunnel.url}/telegram/webhook`;
      const riderUrl = `${tunnel.url}/telegram/rider-webhook`;
      try {
        console.log('→ setting dev webhooks to', { driverUrl, riderUrl });
        await bot.setWebHook(driverUrl);
        await RiderPort.setWebHook(riderUrl);
        console.log('✅ dev webhooks set');
      } catch (err) {
        console.error('❌ dev setWebHook failed:', err);
      }
    } else {
      console.warn('‼️ Could not open localtunnel – webhooks won’t auto‑register');
    }
  }
})();

// Define the openTunnel function
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
        console.error(`   ✖︎ failed (${err.message ?? err})`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  return null;
}
