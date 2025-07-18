// backend/bot.ts

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import bcrypt from 'bcryptjs';
import { Driver, DriverDocument } from './models/Driver';
import { escapeHtml } from './utils/escapeHtml';
import { v2 as cloudinary } from 'cloudinary';

// ────────────────────────────────────────────────────────────────────
// 0) Cloudinary configuration
// ────────────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
  api_key: process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!,
});

// ────────────────────────────────────────────────────────────────────
// 1) Instantiate the Telegram bot
// ────────────────────────────────────────────────────────────────────
export const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, {
  polling: false,
});

// Poll in dev so /start works without a public webhook
if (process.env.NODE_ENV !== 'production') {
  bot.startPolling();
  console.log('⚡ driver bot polling started');
}

// ────────────────────────────────────────────────────────────────────
// 2) Session bookkeeping for the registration flow
// ────────────────────────────────────────────────────────────────────
type Step = 'name' | 'phone' | 'docs' | 'set_pin';
const session = new Map<string, Step>();

// ────────────────────────────────────────────────────────────────────
// 3) Document keys & human‑friendly labels
// ────────────────────────────────────────────────────────────────────
const DOC_KEYS = [
  'profilePhoto', 'vehiclePhoto', 'nationalId', 'vehicleRegistration',
  'driversLicense', 'insuranceCertificate', 'pdpOrPsvBadge',
  'dekraCertificate', 'policeClearance', 'licenseDisc'
] as const;

type DocKey = typeof DOC_KEYS[number];
const nice: Record<DocKey, string> = {
  profilePhoto: 'Driver Profile Photo',
  vehiclePhoto: 'Vehicle Photo (with plate)',
  nationalId: 'National ID Document',
  vehicleRegistration: 'Vehicle Registration / LogBook',
  driversLicense: "Driver's License",
  insuranceCertificate: 'Vehicle Insurance Certificate',
  pdpOrPsvBadge: 'PDP / PSV Badge',
  dekraCertificate: 'DEKRA Certificate',
  policeClearance: 'Police Clearance Certificate',
  licenseDisc: 'Vehicle License Disc'
};

const isImageMime = (m?: string) =>
  !!m && ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    .includes(m.toLowerCase());

// ────────────────────────────────────────────────────────────────────
// 4) Helper — main menu keyboard after registration
// ────────────────────────────────────────────────────────────────────
function mainMenu(d?: DriverDocument) {
  const rows = [
    [{ text: '📊 Status' }, { text: '🔄 Reset' }],
    [{ text: '❓ Help' }]
  ];
  if (d?.status === 'approved') rows.unshift([{ text: '🚗 Dashboard' }]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

// ────────────────────────────────────────────────────────────────────
// 5) /start — Kick off the registration flow
// ────────────────────────────────────────────────────────────────────
bot.onText(/^\/start$/, async msg => {
  const chat = String(msg.chat.id);
  let d = await Driver.findByChatId(chat);
  if (!d) d = await Driver.create({ chatId: chat });

  if (d.registrationStep === 'completed') {
    return bot.sendMessage(chat,
      '🚦 You’re already registered!',
      mainMenu(d)
    );
  }

  session.set(chat, 'name');
  return bot.sendMessage(chat,
    '👋 *Welcome to VayaRide!*’\nPlease enter your *full name* to register:',
    { parse_mode: 'Markdown' }
  );
});

// ────────────────────────────────────────────────────────────────────
// 6) /help — show commands
// ────────────────────────────────────────────────────────────────────
bot.onText(/^\/help$/, msg =>
  bot.sendMessage(
    msg.chat.id,
    '❓ *Help*\n' +
    '/start – begin registration or show menu\n' +
    '/status – view your registration status\n' +
    '/newpin – reset your 4‑digit PIN\n' +
    '/reset – clear registration and start over',
    { parse_mode: 'Markdown' }
  )
);

// ────────────────────────────────────────────────────────────────────
// 7) /status, /newpin, /reset
// ────────────────────────────────────────────────────────────────────
bot.onText(/^\/status$/, async msg => {
  const chat = String(msg.chat.id);
  const d = await Driver.findByChatId(chat);
  if (!d) return bot.sendMessage(chat, '❌ Not registered. Send /start.', mainMenu());

  return bot.sendMessage(chat,
    `📋 Name: ${d.fullName || '—'}\n` +
    `📱 Phone: ${d.phone || '—'}\n` +
    `📄 Docs: ${d.documentsComplete ? '✅ Complete' : '❌ Missing'}\n` +
    `🔖 Status: ${d.status.toUpperCase()}`,
    mainMenu(d)
  );
});

// ────────────────────────────────────────────────────────────────────
// 8) Payment Request: /pay command to initiate the payment process
// ────────────────────────────────────────────────────────────────────
bot.onText(/^\/pay$/, async msg => {
  const chat = String(msg.chat.id);

  // Simulate the amount to be paid (this can be dynamic based on the service)
  const amountToPay = 100; // Example: 100 ZAR for the service

  try {
    // Call the backend endpoint to generate the payment link
    const response = await fetch(`${process.env.BACKEND_URL}/generate-payment-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: chat, amount: amountToPay })
    });

    const data = await response.json();

    if (data.error) {
      return bot.sendMessage(chat, `❌ Error: ${data.error}`);
    }

    // Payment link sent to user
    return bot.sendMessage(chat, `💳 To complete your payment of ${amountToPay} ZAR, please follow this link: ${data.paymentLink}`);
  } catch (error) {
    console.error(error);
    return bot.sendMessage(chat, '❌ An error occurred while processing your payment request.');
  }
});

// ────────────────────────────────────────────────────────────────────
// 9) Document upload flow
// ────────────────────────────────────────────────────────────────────
const docsIntro = () =>
  '📑 *Document Upload*\n' +
  'Send each item one‑by‑one in this order:\n\n' +
  DOC_KEYS.map((k, i) => `${i + 1}. ${nice[k]}`).join('\n') +
  '\n\nI’ll prompt after each upload.';

bot.on('message', async (m: Message) => {
  if ((m.text?.startsWith('/')) || (!m.text && !m.photo && !m.document)) return;

  const chat = String(m.chat.id);
  const step = session.get(chat);
  if (!step) return;

  const d = await Driver.findByChatId(chat);
  if (!d) return;

  if (step === 'name' && m.text) {
    const name = m.text.trim();
    if (name.length < 2 || name.length > 50)
      return bot.sendMessage(chat, '❌ Name must be 2–50 characters.');
    d.fullName = name;
    d.registrationStep = 'phone';
    await d.save();
    session.set(chat, 'phone');
    return bot.sendMessage(chat, '📞 Great! Now send your *contact number* (+country code):', { parse_mode: 'Markdown' });
  }

  if (step === 'phone' && m.text) {
    const phone = m.text.replace(/\s+/g, '');
    if (!/^\+?[1-9]\d{7,14}$/.test(phone))
      return bot.sendMessage(chat, '❌ Invalid phone format.');
    if (await Driver.findOne({ phone, _id: { $ne: d._id } }))
      return bot.sendMessage(chat, '🚫 That number is already in use.');
    d.phone = phone;
    d.registrationStep = 'documents';
    await d.save();
    session.set(chat, 'docs');
    return bot.sendMessage(chat, docsIntro(), { parse_mode: 'Markdown' });
  }

  if (step === 'docs') {
    const key = DOC_KEYS.find(k => !d.documents[k]);
    if (!key) return;

    const fileId = m.document?.file_id ?? m.photo![m.photo!.length - 1].file_id;
    
    let tgUrl: string;
    try { tgUrl = await bot.getFileLink(fileId); }
    catch { return bot.sendMessage(chat, '❌ Could not fetch file from Telegram.'); }

    let resp: Response;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      resp = await fetch(tgUrl, { signal: ctrl.signal });
      clearTimeout(t);
      if (!resp.ok) throw 0;
    } catch {
      return bot.sendMessage(chat, '❌ Download timed‑out.');
    }

    const mime = m.document?.mime_type;
    let resType: 'image' | 'raw';
    if (isImageMime(mime) || m.photo) resType = 'image';
    else if (mime === 'application/pdf') resType = 'raw';
    else return bot.sendMessage(chat, '❌ Only JPG/PNG images or PDFs allowed.');

    let upload: any;
    try {
      const buf = Buffer.from(await resp.arrayBuffer());
      upload = await new Promise((res, rej) => {
        const s = cloudinary.uploader.upload_stream({
          folder: `vayaride/${chat}`,
          public_id: key,
          resource_type: resType,
          timeout: 180_000
        }, (e, r) => e ? rej(e) : res(r));
        s.end(buf);
      });
    } catch (err: any) {
      console.error(err);
      return bot.sendMessage(chat, `❌ Upload failed: ${err.message || err}`);
    }

    await d.addOrUpdateDocument(key, {
      fileId,
      fileUniqueId: m.document?.file_unique_id ?? m.photo![0].file_unique_id,
      cloudUrl: upload.secure_url,
      format: upload.format,
      bytes: upload.bytes
    });

    const next = DOC_KEYS.find(k => !d.documents[k]);
    if (next) {
      return bot.sendMessage(chat,
        `✅ *${nice[key]}* received!\n` +
        `Please send *${nice[next]}* next.`,
        { parse_mode: 'Markdown' }
      );
    }

    // all docs done
    d.registrationStep = 'completed';
    d.status = 'pending';
    await d.save();
    session.delete(chat);
    return bot.sendMessage(chat,
      '🎉 All documents uploaded! We’ll review you shortly.',
      mainMenu(d)
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // 9) PIN step
  // ────────────────────────────────────────────────────────────────────
  if (step === 'set_pin' && m.text) {
    const pin = m.text.trim();
    if (!/^\d{4}$/.test(pin))
      return bot.sendMessage(chat, '❌ PIN must be exactly 4 digits.');
    const hash = await bcrypt.hash(pin, 10);
    d.pin = { hash, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    await d.save();
    session.delete(chat);
    return bot.sendMessage(chat,
      '✅ PIN saved! It will expire in 24 hours.',
      mainMenu(d)
    );
  }
});

// ────────────────────────────────────────────────────────────────────
// 10) Helper for admin approval — called by your admin API
// ────────────────────────────────────────────────────────────────────
export async function sendApprovalLink(driver: DriverDocument) {
  if (!driver.chatId) return;
  const url = `${process.env.APP_BASE_URL}/driver/login?chat=${driver.chatId}`;

  // Step 1: Congratulate & prompt for PIN
  await bot.sendMessage(
    driver.chatId,
    `🎉 <b>Congratulations, ${escapeHtml(driver.fullName)}!</b>\n\n` +
    `Your application is <b>APPROVED</b>.\n` +
    `🔑 Please create your 4‑digit PIN now.`,
    { parse_mode: 'HTML' }
  );
  session.set(driver.chatId, 'set_pin');

  // Step 2: Dashboard link
  await bot.sendMessage(
    driver.chatId,
    `👉 Once your PIN is set, open your dashboard here:\n${url}`,
    { disable_web_page_preview: true }
  );
}
