import TelegramBot, { Message }      from 'node-telegram-bot-api';
import { v2 as cloud }               from 'cloudinary';
import bcrypt                        from 'bcryptjs';

import { Driver, DriverDocument }    from './models/Driver';
import { escapeHtml }                from './utils/escapeHtml';

/* ------------------------------------------------------------------ */
/* 0 ▸  Cloudinary config                                             */
/* ------------------------------------------------------------------ */
cloud.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME!,
  api_key    : process.env.CLOUDINARY_API_KEY!,
  api_secret : process.env.CLOUDINARY_API_SECRET!
});

/* ------------------------------------------------------------------ */
/* 1 ▸  Telegram bot (no polling in production—webhook only)          */
/* ------------------------------------------------------------------ */
export const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, {
  polling: false
});

/* ------------------------------------------------------------------ */
/* 2 ▸  Session bookkeeping                                           */
/* ------------------------------------------------------------------ */
type Step = 'name' | 'phone' | 'docs' | 'set_pin';
const session = new Map<string, Step>();

/* ------------------------------------------------------------------ */
/* 3 ▸  Documents & labels                                            */
/* ------------------------------------------------------------------ */
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
  !!m && ['image/jpeg','image/png','image/gif','image/webp']
    .includes(m.toLowerCase());

/* ------------------------------------------------------------------ */
/* 4 ▸  Main menu                                                     */
/* ------------------------------------------------------------------ */
function mainMenu(d?: DriverDocument) {
  const rows = [
    [{ text: '📊 Status' }, { text: '🔄 Reset' }],
    [{ text: '❓ Help' }]
  ];
  if (d?.status === 'approved') rows.unshift([{ text: '🚗 Dashboard' }]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

/* ------------------------------------------------------------------ */
/* 5 ▸  /start, /status, /newpin, /reset, /help                       */
/* ------------------------------------------------------------------ */
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
  bot.sendMessage(chat,
    '👋 *Welcome to VayaRide!* Please enter your *full name*:',
    { parse_mode: 'Markdown', ...mainMenu() }
  );
});

bot.onText(/^\/status$/, async msg => {
  const chat = String(msg.chat.id);
  const d = await Driver.findByChatId(chat);
  if (!d) return bot.sendMessage(chat,'❌ Not registered. Use /start.',mainMenu());

  bot.sendMessage(chat,
    `📋 Name: ${d.fullName ?? '—'}\n` +
    `📱 Phone: ${d.phone ?? '—'}\n` +
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
  bot.sendMessage(chat,'🔄 Send a new 4‑digit PIN (example 2468)');
});

bot.onText(/^\/reset$/, async msg => {
  const chat = String(msg.chat.id);
  await Driver.deleteOne({ chatId: chat });
  session.delete(chat);
  bot.sendMessage(chat,'🔄 Registration cleared. Send /start to begin again.');
});

bot.onText(/^\/help$/, msg =>
  bot.sendMessage(
    msg.chat.id,
    '🆘 *Help*\n' +
    '/start – begin registration\n' +
    '/status – show current info\n' +
    '/newpin – generate a new 4‑digit PIN\n' +
    '/reset – wipe registration and start over',
    { parse_mode:'Markdown' }
  )
);

/* ------------------------------------------------------------------ */
/* 6 ▸  Document upload flow                                          */
/* ------------------------------------------------------------------ */
const docsIntro = () =>
  '📑 *Document Upload*\n' +
  'Send each item *one‑by‑one* in this order:\n\n' +
  DOC_KEYS.map((k,i)=>`${i+1}. ${nice[k]}`).join('\n') +
  '\n\nI’ll prompt after each upload.';

bot.on('message', async (m: Message) => {
  // ignore non-text/non-file or commands
  if ((!m.text && !m.document && !m.photo) || m.text?.startsWith('/')) return;

  const chat = String(m.chat.id);
  const step = session.get(chat);
  if (!step) return;
  const d = await Driver.findByChatId(chat);
  if (!d) return;

  /* ——— NAME ——— */
  if (step === 'name' && m.text) {
    const name = m.text.trim();
    if (name.length < 2 || name.length > 50)
      return bot.sendMessage(chat,'❌ Name must be 2–50 chars.');
    d.fullName = name;
    d.registrationStep = 'phone';
    await d.save();
    session.set(chat,'phone');
    return bot.sendMessage(chat,
      '📞 Now send your *phone number* (+country‑code):',
      { parse_mode:'Markdown' }
    );
  }

  /* ——— PHONE ——— */
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
    return bot.sendMessage(chat, docsIntro(), { parse_mode:'Markdown' });
  }

  /* ——— DOCUMENTS ——— */
  if (step === 'docs') {
    if (!m.photo && !m.document) return;
    const nextKey = DOC_KEYS.find(k => !d.documents[k]);
    if (!nextKey) return;

    // (a) get Telegram file URL
    const fileId = m.document?.file_id ?? m.photo![m.photo!.length-1].file_id;
    let tgUrl: string;
    try { tgUrl = await bot.getFileLink(fileId); }
    catch { return bot.sendMessage(chat,'❌ Could not fetch file from Telegram.'); }

    // (b) download (with 5s timeout)
    let tgResp: Response;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      tgResp = await fetch(tgUrl, { signal: ctrl.signal });
      clearTimeout(t);
      if (!tgResp.ok) throw 0;
    } catch {
      return bot.sendMessage(chat,'❌ Telegram download timed‑out.');
    }

    // (c) detect resource_type
    const mime = m.document?.mime_type;
    let resType: 'image'|'raw';
    if (isImageMime(mime) || !!m.photo) {
      resType = 'image';
    } else if (mime === 'application/pdf') {
      resType = 'raw';
    } else {
      return bot.sendMessage(chat,
        '❌ Unsupported file – only JPG/PNG or PDF.'
      );
    }

    // (d) upload to Cloudinary
    let upload: any;
    try {
      const buf = Buffer.from(await tgResp.arrayBuffer());
      upload = await new Promise((res, rej) => {
        const stream = cloud.uploader.upload_stream(
          { folder:`vayaride/${chat}`, public_id:nextKey,
            resource_type:resType, timeout:180_000 },
          (err, result) => err ? rej(err) : res(result)
        );
        stream.end(buf);
      });
    } catch (err) {
      console.error('[DOC] Cloudinary:', err);
      return bot.sendMessage(chat, `❌ Upload failed – ${(err as any)?.message || 'Cloudinary'}`);
    }

    // (e) save metadata
    await d.addOrUpdateDocument(nextKey, {
      fileId,
      fileUniqueId: m.document?.file_unique_id
        ?? m.photo![m.photo!.length-1].file_unique_id,
      cloudUrl: upload.secure_url,
      format  : upload.format,
      bytes   : upload.bytes
    });

    // (f) prompt next or finish
    const remain = DOC_KEYS.find(k => !d.documents[k]);
    if (remain) {
      return bot.sendMessage(chat,
        `✅ *${nice[nextKey]}* received.\n` +
        `Please send *${nice[remain]}* next.`,
        { parse_mode:'Markdown' }
      );
    }

    // all done!
    d.registrationStep = 'completed';
    d.status           = 'pending';
    await d.save();
    session.delete(chat);
    bot.sendMessage(chat,
      '🎉 Docs uploaded! We’ll review and notify you.',
      mainMenu(d)
    );
  }

  /* ——— SET PIN ——— */
  if (step === 'set_pin' && m.text) {
    const pin = m.text.trim();
    if (!/^\d{4}$/.test(pin))
      return bot.sendMessage(chat,'❌ PIN must be exactly 4 digits.');
    const hash = await bcrypt.hash(pin, 10);
    d.pin = { hash, expiresAt: Date.now() + 24*60*60*1000 };
    await d.save();
    session.delete(chat);
    return bot.sendMessage(
      chat,
      '✅ PIN saved. It will expire tomorrow 23:59.',
      mainMenu(d)
    );
  }
});

/* ------------------------------------------------------------------ */
/* 8 ▸  sendApprovalLink – fired by your admin‑API when approving     */
/* ------------------------------------------------------------------ */
export async function sendApprovalLink(driver: DriverDocument) {
  if (!driver.chatId) return;
  const dashLogin = `${process.env.APP_BASE_URL}/driver/login?chat=${driver.chatId}`;

  // 1) Congratulations + PIN prompt
  await bot.sendMessage(
    driver.chatId,
    `🎉 <b>Congratulations ${escapeHtml(driver.fullName)}!</b>\n\n` +
    `Your application is <b>APPROVED</b>.\n` +
    `🔑 Please create a 4‑digit PIN you’ll use to open the dashboard.\n` +
    `Example: 2468`,
    { parse_mode:'HTML' }
  );

  // mark session to pick up the /message handler’s set_pin step
  session.set(driver.chatId, 'set_pin');

  // 2) Dashboard link
  await bot.sendMessage(
    driver.chatId,
    `👉 Tap here after you’ve set your PIN:\n${dashLogin}`,
    { disable_web_page_preview:true }
  );
}
