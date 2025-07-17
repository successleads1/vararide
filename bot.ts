/**********************************************************************
 * bot.ts – VayaRide Driver Bot (registration • PIN • dashboard link)
 * --------------------------------------------------------------------
 * • Registration (name → phone → documents)
 * • Approval → 4‑digit PIN (24 h) → dashboard link
 * • /status   /newpin commands
 *********************************************************************/

import TelegramBot, { Message }      from 'node-telegram-bot-api';
import 'dotenv/config';
import { v2 as cloud }               from 'cloudinary';
import fetch                         from 'node-fetch';
import bcrypt                        from 'bcryptjs';

import { Driver, DriverDocument }    from './models/Driver.js';

/* ------------------------------------------------------------------ */
/* 0 ▸  Cloudinary config                                             */
/* ------------------------------------------------------------------ */
cloud.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME!,
  api_key    : process.env.CLOUDINARY_API_KEY!,
  api_secret : process.env.CLOUDINARY_API_SECRET!
});

/* ------------------------------------------------------------------ */
/* 1 ▸  Telegram bot (webhook mode)                                   */
/* ------------------------------------------------------------------ */
export const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, {
  polling: false
});

/* ------------------------------------------------------------------ */
/* 2 ▸  Session bookkeeping                                           */
/* ------------------------------------------------------------------ */
type Step = 'name' | 'phone' | 'docs' | 'set_pin';
const session = new Map<string, Step>();

/* ---------- required documents, pretty labels -------------------- */
const DOC_KEYS: (keyof DriverDocument['documents'])[] = [
  'profilePhoto', 'vehiclePhoto', 'nationalId', 'vehicleRegistration',
  'driversLicense', 'insuranceCertificate', 'pdpOrPsvBadge',
  'dekraCertificate', 'policeClearance', 'licenseDisc'
];
const nice: Record<keyof DriverDocument['documents'], string> = {
  profilePhoto        : 'Driver Profile Photo',
  vehiclePhoto        : 'Vehicle Photo with Number Plate',
  nationalId          : 'National Identity Document',
  vehicleRegistration : 'Vehicle Registration / LogBook',
  driversLicense      : "Driver's License",
  insuranceCertificate: 'Vehicle Insurance Certificate',
  pdpOrPsvBadge       : 'PDP / PSV Badge',
  dekraCertificate    : 'DEKRA Certificate',
  policeClearance     : 'Police Clearance Certificate',
  licenseDisc         : 'Vehicle License Disc'
};

const isImageMime = (m?: string) =>
  !!m && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(m.toLowerCase());

/* ------------------------------------------------------------------ */
/* 3 ▸  Keyboards / menus                                             */
/* ------------------------------------------------------------------ */
function mainMenu (d?: DriverDocument) {
  const rows = [
    [{ text: '📊 Status' }, { text: '🔄 Reset' }],
    [{ text: '❓ Help' }]
  ];
  if (d?.status === 'approved') rows.unshift([{ text: '🚗 Dashboard' }]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

/* ------------------------------------------------------------------ */
/* 4 ▸  Commands                                                      */
/* ------------------------------------------------------------------ */
bot.onText(/^\/start$/, async msg => {
  const chat = String(msg.chat.id);
  let d = await Driver.findByChatId(chat);
  if (!d) d = await Driver.create({ chatId: chat });

  if (d.registrationStep === 'completed') {
    return bot.sendMessage(chat, '🚦 You’re already registered!', mainMenu(d));
  }

  session.set(chat, 'name');
  bot.sendMessage(
    chat,
    '👋 *Welcome to VayaRide!* Please enter your *full name*:',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/status$/, async msg => {
  const chat = String(msg.chat.id);
  const d = await Driver.findByChatId(chat);
  if (!d) return bot.sendMessage(chat,'❌ Not registered. Use /start.',mainMenu());

  bot.sendMessage(
    chat,
    `📋 Name: ${d.fullName}\n` +
    `📱 Phone: ${d.phone}\n` +
    `📄 Docs: ${d.documentsComplete ? '✅ Complete' : '❌ Incomplete'}\n` +
    `🔖 Status: ${d.status.toUpperCase()}`,
    mainMenu(d)
  );
});

bot.onText(/^\/newpin$/, async msg => {
  const chat = String(msg.chat.id);
  const d = await Driver.findByChatId(chat);
  if (!d) return bot.sendMessage(chat,'⚠️ You’re not registered.');
  d.pin = undefined;
  await d.save();
  session.set(chat,'set_pin');
  bot.sendMessage(chat,'🔄 Send a new 4‑digit PIN (example 2468)');
});

/* ------------------------------------------------------------------ */
/* 5 ▸  Helper: document intro text                                   */
/* ------------------------------------------------------------------ */
const docsIntro = () =>
  '📑 *Document Upload*\n' +
  'Send each item *one‑by‑one* in this order:\n\n' +
  DOC_KEYS.map((k,i)=>`${i+1}. ${nice[k]}`).join('\n') +
  '\n\nI’ll prompt you after each upload.';

/* ------------------------------------------------------------------ */
/* 6 ▸  Main message handler                                          */
/* ------------------------------------------------------------------ */
bot.on('message', async (m: Message) => {
  /* ignore non‑files / commands */
  if (!m.text && !m.document && !m.photo) return;
  if (m.text?.startsWith('/')) return;

  const chat = String(m.chat.id);
  const step = session.get(chat);
  if (!step) return;

  const d = await Driver.findByChatId(chat);
  if (!d) return;

  /* ---------- 1) NAME ------------------------------------------- */
  if (step === 'name' && m.text) {
    const name = m.text.trim();
    if (name.length < 2 || name.length > 50)
      return bot.sendMessage(chat,'❌ Name must be 2–50 chars.');
    d.fullName = name;
    d.registrationStep = 'phone';
    await d.save();
    session.set(chat,'phone');
    return bot.sendMessage(chat,'📞 Now send your *phone number* (with country code):',
      { parse_mode:'Markdown' });
  }

  /* ---------- 2) PHONE ------------------------------------------ */
  if (step === 'phone' && m.text) {
    const phone = m.text.replace(/\s+/g,'');
    if (!/^\+?[1-9]\d{7,14}$/.test(phone))
      return bot.sendMessage(chat,'❌ Invalid phone format.');
    const dup = await Driver.findOne({ phone, _id: { $ne: d._id } });
    if (dup) return bot.sendMessage(chat,'🚫 Phone already in use.');
    d.phone = phone;
    d.registrationStep = 'documents';
    await d.save();
    session.set(chat,'docs');
    return bot.sendMessage(chat,docsIntro(),{ parse_mode:'Markdown' });
  }

  /* ---------- 3) DOCUMENTS -------------------------------------- */
  if (step === 'docs') {
    if (!m.photo && !m.document) return;
    const nextKey = DOC_KEYS.find(k=>!d.documents[k]);
    if (!nextKey) return;   // shouldn’t happen

    /* a) Telegram file URL */
    const fileId = m.document?.file_id ?? m.photo![m.photo!.length-1].file_id;
    let tgUrl: string;
    try { tgUrl = await bot.getFileLink(fileId); }
    catch { return bot.sendMessage(chat,'❌ Could not fetch file from Telegram.'); }

    /* b) download (5 s) */
    let tgResp;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(),5000);
      tgResp = await fetch(tgUrl,{ signal: ctrl.signal });
      clearTimeout(t);
      if (!tgResp.ok) throw 0;
    } catch { return bot.sendMessage(chat,'❌ Telegram download timed‑out.'); }

    /* c) choose Cloudinary resource_type */
    const mime = m.document?.mime_type;
    let resType: 'image' | 'raw';
    switch (true) {
      case isImageMime(mime):
      case !!m.photo:
        resType = 'image';
        break;
      case mime === 'application/pdf':
        resType = 'raw';     // PDFs must use "raw"
        break;
      default:
        return bot.sendMessage(chat,
          '❌ Unsupported file type. Only JPG/PNG and PDF are allowed.');
    }

   
 /* d) Cloudinary upload — retry once with buffer ------------------ */
let upload: any;
try {
  const mime = m.document?.mime_type ??
               (m.photo ? 'image/jpeg' : 'application/octet-stream');

  const buf      = Buffer.from(await tgResp.arrayBuffer());
  const dataUri  = `data:${mime};base64,${buf.toString('base64')}`;

  upload = await cloud.uploader.upload(dataUri, {
    folder: `vayaride/${chat}`,
    public_id: nextKey,
    resource_type: resType,
    timeout: 180_000               // 3 min
  });
} catch (err) {
  console.error('[DOC] Cloudinary error:', err);
  const msg = (err as any)?.message ?? 'Upload failed (Cloudinary)';
  return bot.sendMessage(chat, `❌ ${msg}`);
}


    /* e) Save doc metadata to Mongo */
    await d.addOrUpdateDocument(nextKey,{
      fileId,
      fileUniqueId: m.document?.file_unique_id ??
                    m.photo![m.photo!.length-1].file_unique_id,
      cloudUrl: upload.secure_url,
      format  : upload.format,
      bytes   : upload.bytes
    });

    /* f) Next prompt or finish */
    const remain = DOC_KEYS.find(k=>!d.documents[k]);
    if (remain) {
      return bot.sendMessage(chat,
        `✅ *${nice[nextKey]}* received.\nPlease send *${nice[remain]}* next.`,
        { parse_mode:'Markdown' });
    }

    // all 10 docs collected
    d.registrationStep = 'completed';
    d.status = 'pending';
    await d.save();
    session.delete(chat);

    bot.sendMessage(chat,
      '🎉 All documents uploaded! We’ll review and notify you here.',
      mainMenu(d)
    );
  }

  /* ---------- 4) SET 4‑DIGIT PIN -------------------------------- */
  if (step === 'set_pin' && m.text) {
    const pin = m.text.trim();
    if (!/^\d{4}$/.test(pin))
      return bot.sendMessage(chat,'❌ PIN must be exactly 4 digits.');
    const hash = await bcrypt.hash(pin,10);
    d.pin = { hash, expiresAt: Date.now() + 24*60*60*1000 };
    await d.save();
    session.delete(chat);
    return bot.sendMessage(chat,
      '✅ PIN saved. It will expire tomorrow at 23:59.',
      mainMenu(d)
    );
  }
});

/* ------------------------------------------------------------------ */
/* 7 ▸  sendApprovalLink – begins the PIN flow                        */
/* ------------------------------------------------------------------ */
export async function sendApprovalLink (driver: DriverDocument) {
  if (!driver.chatId) return;

  const dashLogin =
    `${process.env.APP_BASE_URL}/driver/login?chat=${driver.chatId}`;

  await bot.sendMessage(
    driver.chatId,
    `🎉 <b>Congratulations ${driver.fullName}!</b>\n\n` +
    `Your application is <b>APPROVED</b>.\n` +
    `🔑 Before you can log in, create a 4‑digit PIN you’ll use to open the dashboard.\n` +
    `Example: 2468`,
    { parse_mode:'HTML' }
  );

  session.set(driver.chatId,'set_pin');   // start PIN step

  await bot.sendMessage(
    driver.chatId,
    `👉 Tap here after you’ve set your PIN:\n${dashLogin}`,
    { disable_web_page_preview:true }
  );
}
