// backend/bot.ts

import 'dotenv/config'
import TelegramBot, { Message } from 'node-telegram-bot-api'
import { v2 as cloudinary }     from 'cloudinary'
import fetch                     from 'node-fetch'
import bcrypt                    from 'bcryptjs'

import { Driver, DriverDocument } from './models/Driver'
import { escapeHtml }             from './utils/escapeHtml'

/* ------------------------------------------------------------------
 * 0) Cloudinary configuration
 * ------------------------------------------------------------------ */
cloudinary.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME!,
  api_key    : process.env.CLOUDINARY_API_KEY!,
  api_secret : process.env.CLOUDINARY_API_SECRET!
})

/* ------------------------------------------------------------------
 * 1) Telegram bot instance (webhook mode; no polling in prod)
 * ------------------------------------------------------------------ */
export const bot = new TelegramBot(process.env.DRIVER_BOT_TOKEN!, {
  polling: false
})

/* ------------------------------------------------------------------
 * 2) Registration session state
 * ------------------------------------------------------------------ */
type Step = 'name' | 'phone' | 'docs' | 'set_pin'
const session = new Map<string, Step>()

/* ------------------------------------------------------------------
 * 3) Document upload keys & human‑friendly labels
 * ------------------------------------------------------------------ */
const DOC_KEYS: (keyof DriverDocument['documents'])[] = [
  'profilePhoto','vehiclePhoto','nationalId','vehicleRegistration',
  'driversLicense','insuranceCertificate','pdpOrPsvBadge',
  'dekraCertificate','policeClearance','licenseDisc'
]
const nice: Record<keyof DriverDocument['documents'],string> = {
  profilePhoto        : 'Driver Profile Photo',
  vehiclePhoto        : 'Vehicle Photo (with plate)',
  nationalId          : 'National ID Document',
  vehicleRegistration : 'Vehicle Registration / LogBook',
  driversLicense      : "Driver's License",
  insuranceCertificate: 'Insurance Certificate',
  pdpOrPsvBadge       : 'PDP / PSV Badge',
  dekraCertificate    : 'DEKRA Certificate',
  policeClearance     : 'Police Clearance',
  licenseDisc         : 'Vehicle License Disc'
}
const isImageMime = (m?: string) =>
  !!m && ['image/jpeg','image/png','image/gif','image/webp']
    .includes(m.toLowerCase())

/* ------------------------------------------------------------------
 * 4) Main menu keyboard
 * ------------------------------------------------------------------ */
function mainMenu(d?: DriverDocument) {
  const rows = [
    [{ text: '📊 Status' }, { text: '🔄 Reset' }],
    [{ text: '❓ Help' }]
  ]
  if (d?.status === 'approved') rows.unshift([{ text: '🚗 Dashboard' }])
  return { reply_markup: { keyboard: rows, resize_keyboard: true } }
}

/* ------------------------------------------------------------------
 * 5) Core commands: /start, /status, /newpin, /reset, /help
 * ------------------------------------------------------------------ */
bot.onText(/^\/start$/, async msg => {
  const chat = String(msg.chat.id)
  let d = await Driver.findByChatId(chat)
  if (!d) d = await Driver.create({ chatId: chat })

  if (d.registrationStep === 'completed') {
    return bot.sendMessage(chat,
      '🚦 You’re already registered!',
      mainMenu(d)
    )
  }

  session.set(chat, 'name')
  return bot.sendMessage(chat,
    '👋 *Welcome to VayaRide!* Please enter your *full name*:',
    { parse_mode:'Markdown', ...mainMenu() }
  )
})

bot.onText(/^\/status$/, async msg => {
  const chat = String(msg.chat.id)
  const d = await Driver.findByChatId(chat)
  if (!d) return bot.sendMessage(chat,'❌ Not registered. Use /start.',mainMenu())

  return bot.sendMessage(chat,
    `📋 Name: ${d.fullName || '—'}\n` +
    `📱 Phone: ${d.phone     || '—'}\n` +
    `📄 Docs: ${d.documentsComplete ? '✅ Complete' : '❌ Missing'}\n` +
    `🔖 Status: ${d.status.toUpperCase()}`,
    mainMenu(d)
  )
})

bot.onText(/^\/newpin$/, async msg => {
  const chat = String(msg.chat.id)
  const d = await Driver.findByChatId(chat)
  if (!d) return bot.sendMessage(chat,'⚠️ You’re not registered.')
  d.pin = undefined
  await d.save()
  session.set(chat,'set_pin')
  return bot.sendMessage(chat,'🔄 Send a new 4‑digit PIN (e.g. 2468)')
})

bot.onText(/^\/reset$/, async msg => {
  const chat = String(msg.chat.id)
  await Driver.deleteOne({ chatId: chat })
  session.delete(chat)
  return bot.sendMessage(chat,'🔄 Registration cleared. Send /start.')
})

bot.onText(/^\/help$/, msg =>
  bot.sendMessage(
    msg.chat.id,
    '🆘 *Help*\n' +
    '/start – begin registration\n' +
    '/status – check status\n' +
    '/newpin – reset your 4‑digit PIN\n' +
    '/reset – clear everything and start over',
    { parse_mode:'Markdown' }
  )
)

/* ------------------------------------------------------------------
 * 6) Document‑upload flow
 * ------------------------------------------------------------------ */
const docsIntro = () =>
  '📑 *Document Upload*\n' +
  'Send each item one‑by‑one in this order:\n\n' +
  DOC_KEYS.map((k,i)=>`${i+1}. ${nice[k]}`).join('\n') +
  '\n\nI’ll prompt after each.'

bot.on('message', async m => {
  // ignore commands and non‑files/text
  if ((m.text?.startsWith('/')) || (!m.text && !m.photo && !m.document)) return

  const chat = String(m.chat.id)
  const step = session.get(chat)
  if (!step) return
  const d = await Driver.findByChatId(chat)
  if (!d) return

  /* NAME */
  if (step === 'name' && m.text) {
    const name = m.text.trim()
    if (name.length < 2 || name.length > 50)
      return bot.sendMessage(chat,'❌ Name must be 2–50 chars.')
    d.fullName = name
    d.registrationStep = 'phone'
    await d.save()
    session.set(chat,'phone')
    return bot.sendMessage(chat,
      '📞 Now send your *phone number* (+country‑code):',
      { parse_mode:'Markdown' }
    )
  }

  /* PHONE */
  if (step === 'phone' && m.text) {
    let phone = m.text.replace(/\s+/g,'')
    if (!/^\+?[1-9]\d{7,14}$/.test(phone))
      return bot.sendMessage(chat,'❌ Invalid phone format.')
    // ensure uniqueness
    const dup = await Driver.findOne({ phone, _id:{ $ne:d._id } })
    if (dup) return bot.sendMessage(chat,'🚫 Phone already used.')
    d.phone = phone
    d.registrationStep = 'documents'
    await d.save()
    session.set(chat,'docs')
    return bot.sendMessage(chat, docsIntro(),{ parse_mode:'Markdown' })
  }

  /* DOCUMENTS */
  if (step === 'docs') {
    const nextKey = DOC_KEYS.find(k=>!d.documents[k])
    if (!nextKey) return

    // get Telegram file URL
    const fileId = m.document?.file_id ?? m.photo![m.photo!.length-1].file_id
    let fileUrl: string
    try { fileUrl = await bot.getFileLink(fileId) }
    catch { return bot.sendMessage(chat,'❌ Could not fetch file.') }

    // download with 5s timeout
    let resp: Response
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 5000)
      resp = await fetch(fileUrl,{ signal: ctrl.signal })
      clearTimeout(t)
      if (!resp.ok) throw 0
    } catch {
      return bot.sendMessage(chat,'❌ Download timed‑out.')
    }

    // decide resource_type
    const mime = m.document?.mime_type
    let resType: 'image'|'raw'
    if (isImageMime(mime)||m.photo) resType='image'
    else if (mime==='application/pdf') resType='raw'
    else return bot.sendMessage(chat,'❌ Only JPG/PNG or PDF.')

    // upload to Cloudinary
    let upload: any
    try {
      const buf = Buffer.from(await resp.arrayBuffer())
      upload = await new Promise((r,j)=>
        cloudinary.uploader.upload_stream(
          { folder:`vayaride/${chat}`,public_id:nextKey,resource_type:resType },
          (e,res) => e?j(e):r(res)
        ).end(buf)
      )
    } catch (e) {
      console.error('[DOC]',e)
      return bot.sendMessage(chat,'❌ Upload failed.')
    }

    // save metadata
    await d.addOrUpdateDocument(nextKey,{
      fileId,
      fileUniqueId: m.document?.file_unique_id ?? m.photo![0].file_unique_id,
      cloudUrl:    upload.secure_url,
      format:      upload.format,
      bytes:       upload.bytes
    })

    // next or finish
    const remain = DOC_KEYS.find(k=>!d.documents[k])
    if (remain) {
      return bot.sendMessage(chat,
        `✅ *${nice[nextKey]}* received.\n`+
        `Send *${nice[remain]}* next.`,
        { parse_mode:'Markdown' }
      )
    }

    // all done
    d.registrationStep='completed'
    d.status='pending'
    await d.save()
    session.delete(chat)
    return bot.sendMessage(chat,
      '🎉 All docs uploaded! We’ll review you soon.',
      mainMenu(d)
    )
  }

  /* SET PIN */
  if (step==='set_pin' && m.text) {
    const pin = m.text.trim()
    if (!/^\d{4}$/.test(pin))
      return bot.sendMessage(chat,'❌ PIN must be 4 digits.')
    d.pin = { hash: await bcrypt.hash(pin,10), expiresAt: Date.now()+86400000 }
    await d.save()
    session.delete(chat)
    return bot.sendMessage(chat,
      '✅ PIN saved (expires in 24 h).',
      mainMenu(d)
    )
  }
})

/* ------------------------------------------------------------------
 * 7) sendApprovalLink – called by your admin‑API on approval
 * ------------------------------------------------------------------ */
export async function sendApprovalLink(driver:DriverDocument) {
  if (!driver.chatId) return
  const url = `${process.env.APP_BASE_URL}/driver/login?chat=${driver.chatId}`

  // congrats + PIN prompt
  await bot.sendMessage(
    driver.chatId,
    `🎉 <b>Congratulations ${escapeHtml(driver.fullName)}!</b>\n`+
    `Your application is <b>APPROVED</b>.\n`+
    `🔑 Create your 4‑digit PIN now.`,
    { parse_mode:'HTML' }
  )
  session.set(driver.chatId,'set_pin')

  // dashboard link
  await bot.sendMessage(
    driver.chatId,
    `👉 When you’ve set your PIN, open here:\n${url}`,
    { disable_web_page_preview:true }
  )
}
