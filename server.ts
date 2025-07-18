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

// Extract environment variables
const {
  PORT = '4000',
  PUBLIC_SOCKET_ORIGIN = '*',
  NODE_ENV,
  DEV_TUNNEL,
  TELEGRAM_WEBHOOK_URL,
  RIDER_WEBHOOK_URL,
  MONGODB_URI
} = process.env;

console.log(`🟢 Starting server in ${NODE_ENV} mode on PORT = ${PORT}`);

// Check required environment variables
if (!MONGODB_URI) {
  console.error('❌  MONGODB_URI missing');
  process.exit(1);
}
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌  TELEGRAM_BOT_TOKEN missing');
  process.exit(1);
}

// Get the current directory name for EJS setup
const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Set up EJS for payment page
const app = express();
app.use(express.json({ limit: '10mb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Webhook and API routes
app.post('/telegram/webhook', express.json({ limit: '10mb' }), telegramRouter);

app.post('/telegram/rider-webhook', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    await RiderPort.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('rider-webhook error:', err);
    res.sendStatus(500);
  }
});

// Admin notify-approval route
app.post('/admin/notify-approval', async (req, res) => {
  try {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ error: 'driverId required' });

    const driver = await Driver.findById(driverId);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    driver.status = 'approved';
    await driver.save();
    await sendApprovalLink(driver);
    res.json({ success: true });
  } catch (err) {
    console.error('notify-approval error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Function to open localtunnel in development mode
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

// MongoDB connection & server startup
;(async () => {
  await connectDB();
  console.log('✅  MongoDB connected');

  const http = createServer(app);
  const io = new IO(http, { cors: { origin: PUBLIC_SOCKET_ORIGIN } });

  io.on('connection', socket => {
    console.log('⚡ Socket connected:', socket.id);
    socket.on('disconnect', () => console.log('⚡ Socket disconnected:', socket.id));
  });

  http.listen(Number(PORT), () => console.log(`> backend running on http://localhost:${PORT}`));

  // Webhook registration for production
  if (NODE_ENV === 'production') {
    try {
      const info = await bot.getWebHookInfo();
      if (info.url !== TELEGRAM_WEBHOOK_URL) {
        console.log('→ setting production driver webhook…');
        await bot.setWebHook(TELEGRAM_WEBHOOK_URL!);
      } else {
        console.log('✔︎ driver webhook already set');
      }
    } catch (err: any) {
      if (err.response?.statusCode === 429) {
        console.warn('⚠️  driver setWebHook rate-limited');
      } else {
        console.error('❌ driver setWebHook error:', err);
      }
    }

    try {
      const info = await bot.getWebHookInfo();
      if (info.url !== RIDER_WEBHOOK_URL) {
        console.log('→ setting production rider webhook…');
        await RiderPort.setWebHook(RIDER_WEBHOOK_URL!);
      } else {
        console.log('✔︎ rider webhook already set');
      }
    } catch (err: any) {
      if (err.response?.statusCode === 429) {
        console.warn('⚠️  rider setWebHook rate-limited');
      } else {
        console.error('❌ rider setWebHook error:', err);
      }
    }
  } else {
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
      console.warn('‼️  Could not open localtunnel – webhooks won’t auto-register');
    }
  }
})();
