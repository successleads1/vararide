// backend/bot.ts

import 'dotenv/config'
import TelegramBot, { Message } from 'node-telegram-bot-api'
import { v2 as cloudinary }     from 'cloudinary'
import fetch                     from 'node-fetch'
import bcrypt                    from 'bcryptjs'

import { Driver, DriverDocument } from './models/Driver'
import { escapeHtml }             from './utils/escapeHtml'

/*─────────────────────────────────────────────────────────────────────*/
/* 0 ▸ Cloudinary config                                              */
/*─────────────────────────────────────────────────────────────────────*/
cloudinary.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME!,
  api_key    : process.env.CLOUDINARY_API_KEY!,
  api_secret : process.env.CLOUDINARY_API_SECRET!
})

/*─────────────────────────────────────────────────────────────────────*/
/* 1 ▸ Telegram bot (webhook mode)                                     */
/*─────────────────────────────────────────────────────────────────────*/
export const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, {
  polling: false
})

// Poll in dev so /start works without webhooks:
if (process.env.NODE_ENV !== 'production') {
  bot.startPolling()
  console.log('⚡ driver bot polling started')
}

/*─────────────────────────────────────────────────────────────────────*/
/* 2 ▸ Session bookkeeping for driver registration                    */
/*─────────────────────────────────────────────────────────────────────*/
type Step = 'name' | 'phone' | 'docs' | 'set_pin'
const session = new Map<string, Step>()

/*─────────────────────────────────────────────────────────────────────*/
/* 3 ▸ Document keys & labels                                         */
/*─────────────────────────────────────────────────────────────────────*/
const DOC_KEYS = [
  'profilePhoto','vehiclePhoto','nationalId','vehicleRegistration',
  'driversLicense','insuranceCertificate','pdpOrPsvBadge',
  'dekraCertificate','policeClearance','licenseDisc'
] as const
type DocKey = typeof DOC_KEYS[number]
const nice: Record<DocKey,string> = {
  profilePhoto        : 'Driver Profile Photo',
  vehiclePhoto        : 'Vehicle Photo (with plate)',
  nationalId          : 'National ID Document',
  vehicleRegistration : 'Vehicle Registration / LogBook',
  driversLicense      : "Driver's License",
  insuranceCertificate: 'Vehicle Insurance Certificate',
  pdpOrPsvBadge       : 'PDP / PSV Badge',
  dekraCertificate    : 'DEKRA Certificate',
  policeClearance     : 'Police Clearance Certificate',
  licenseDisc         : 'Vehicle License Disc'
}
const isImageMime = (m?:string) =>
  !!m && ['image/jpeg','image/png','image/gif','image/webp']
    .includes(m.toLowerCase())

/*─────────────────────────────────────────────────────────────────────*/
/* 4 ▸ Main menu keyboard                                             */
/*─────────────────────────────────────────────────────────────────────*/
function mainMenu(d?:DriverDocument) {
  const rows = [
    [{ text:'📊 Status' },{ text:'🔄 Reset' }],
    [{ text:'❓ Help' }]
  ]
  if (d?.status==='approved') rows.unshift([{ text:'🚗 Dashboard' }])
  return { reply_markup:{ keyboard:rows, resize_keyboard:true } }
}

/*─────────────────────────────────────────────────────────────────────*/
/* 5 ▸ /start & /help                                                  */
/*─────────────────────────────────────────────────────────────────────*/
bot.onText(/^\/start$/, msg => {
  const chat = String(msg.chat.id)
  return bot.sendMessage(
    chat,
    '👋 Welcome to VayaRide Driver Bot!\nSend /help to see commands.',
    { parse_mode:'Markdown' }
  )
})

bot.onText(/^\/help$/, msg =>
  bot.sendMessage(
    msg.chat.id,
    '❓ *Help*\n' +
    '/start – show this message\n' +
    '/status – view your registration status\n' +
    '/newpin – reset your 4‑digit PIN\n' +
    '/reset – clear your registration and start over',
    { parse_mode:'Markdown' }
  )
)

/*─────────────────────────────────────────────────────────────────────*/
/* 6 ▸ Core driver flows                                                */
/*─────────────────────────────────────────────────────────────────────*/
bot.onText(/^\/status$/, async msg => {
  const chat = String(msg.chat.id)
  const d = await Driver.findByChatId(chat)
  if (!d) return bot.sendMessage(chat,'❌ Not registered. Use /start.', mainMenu())

  return bot.sendMessage(chat,
    `📋 Name: ${d.fullName||'—'}\n`+
    `📱 Phone: ${d.phone||'—'}\n`+
    `📄 Docs: ${d.documentsComplete?'✅ Complete':'❌ Missing'}\n`+
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
  return bot.sendMessage(chat,'🔄 Send a new 4‑digit PIN (e.g. 2468)')
})

bot.onText(/^\/reset$/, async msg => {
  const chat = String(msg.chat.id)
  await Driver.deleteOne({ chatId:chat })
  session.delete(chat)
  return bot.sendMessage(chat,'🔄 Registration cleared. Send /start to begin again.')
})

/*─────────────────────────────────────────────────────────────────────*/
/* 7 ▸ Document upload flow                                            */
/*─────────────────────────────────────────────────────────────────────*/
const docsIntro = () =>
  '📑 *Document Upload*\n' +
  'Send each item one‑by‑one in this order:\n\n' +
  DOC_KEYS.map((k,i)=>`${i+1}. ${nice[k]}`).join('\n') +
  '\n\nI’ll prompt after each upload.'

bot.on('message', async (m:Message) => {
  if ((m.text?.startsWith('/')) || (!m.text && !m.photo && !m.document)) return
  const chat = String(m.chat.id)
  const step = session.get(chat)
  if (!step) return
  const d = await Driver.findByChatId(chat)
  if (!d) return

  if (step==='name' && m.text) {
    const name = m.text.trim()
    if (name.length<2||name.length>50)
      return bot.sendMessage(chat,'❌ Name must be 2–50 chars.')
    d.fullName = name; d.registrationStep='phone'; await d.save()
    session.set(chat,'phone')
    return bot.sendMessage(chat,'📞 Now send your *phone number* (+country):',{ parse_mode:'Markdown' })
  }

  if (step==='phone' && m.text) {
    const phone = m.text.replace(/\s+/g,'')
    if (!/^\+?[1-9]\d{7,14}$/.test(phone))
      return bot.sendMessage(chat,'❌ Invalid phone format.')
    if (await Driver.findOne({ phone,_id:{ $ne:d._id } }))
      return bot.sendMessage(chat,'🚫 Phone already in use.')
    d.phone=phone; d.registrationStep='documents'; await d.save()
    session.set(chat,'docs')
    return bot.sendMessage(chat, docsIntro(), { parse_mode:'Markdown' })
  }

  if (step==='docs') {
    const key = DOC_KEYS.find(k=>!d.documents[k])
    if (!key) return
    const fileId = m.document?.file_id ?? m.photo![m.photo!.length-1].file_id
    let url:string
    try { url = await bot.getFileLink(fileId) }
    catch { return bot.sendMessage(chat,'❌ Could not fetch file.') }

    let resp:Response
    try {
      const ctrl = new AbortController()
      const t = setTimeout(()=>ctrl.abort(),5000)
      resp = await fetch(url,{ signal:ctrl.signal })
      clearTimeout(t)
      if (!resp.ok) throw 0
    } catch {
      return bot.sendMessage(chat,'❌ Download timed‑out.')
    }

    const mime = m.document?.mime_type
    let type:'image'|'raw'
    if (isImageMime(mime)||!!m.photo) type='image'
    else if (mime==='application/pdf') type='raw'
    else return bot.sendMessage(chat,'❌ Only JPG/PNG or PDF.')

    let up:any
    try {
      const buf = Buffer.from(await resp.arrayBuffer())
      up = await new Promise((res,rej)=>{
        const s = cloudinary.uploader.upload_stream({
          folder:`vayaride/${chat}`,public_id:key,resource_type:type,timeout:180000
        },(e,r)=>e?rej(e):res(r))
        s.end(buf)
      })
    } catch (e:any) {
      console.error(e)
      return bot.sendMessage(chat,`❌ Upload failed: ${e.message||e}`)
    }

    await d.addOrUpdateDocument(key,{
      fileId,
      fileUniqueId:m.document?.file_unique_id ?? m.photo![0].file_unique_id,
      cloudUrl:up.secure_url,
      format:up.format,bytes:up.bytes
    })

    const next = DOC_KEYS.find(k=>!d.documents[k])
    if (next) {
      return bot.sendMessage(chat,
        `✅ *${nice[key]}* received.\nSend *${nice[next]}* next.`,
        { parse_mode:'Markdown' }
      )
    }

    d.registrationStep='completed'; d.status='pending'; await d.save()
    session.delete(chat)
    return bot.sendMessage(chat,'🎉 All docs uploaded! We’ll review you shortly.', mainMenu(d))
  }

  if (step==='set_pin' && m.text) {
    const pin = m.text.trim()
    if (!/^\d{4}$/.test(pin))
      return bot.sendMessage(chat,'❌ PIN must be 4 digits.')
    d.pin = { hash:await bcrypt.hash(pin,10), expiresAt:Date.now()+86400000 }
    await d.save()
    session.delete(chat)
    return bot.sendMessage(chat,'✅ PIN saved (expires in 24 h).', mainMenu(d))
  }
})

/*─────────────────────────────────────────────────────────────────────*/
/* 8 ▸ sendApprovalLink – called by admin API                         */
/*─────────────────────────────────────────────────────────────────────*/
export async function sendApprovalLink(driver:DriverDocument) {
  if (!driver.chatId) return
  const url = `${process.env.APP_BASE_URL}/driver/login?chat=${driver.chatId}`
  await bot.sendMessage(
    driver.chatId,
    `🎉 <b>Congratulations ${escapeHtml(driver.fullName)}!</b>\n\n`+
    `Your application is <b>APPROVED</b>.\n🔑 Create your 4‑digit PIN now.`,
    { parse_mode:'HTML' }
  )
  session.set(driver.chatId,'set_pin')
  await bot.sendMessage(
    driver.chatId,
    `👉 Tap here after you’ve set your PIN:\n${url}`,
    { disable_web_page_preview:true }
  )
}
