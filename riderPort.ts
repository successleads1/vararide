// backend/riderPort.ts

import 'dotenv/config'
import TelegramBot, { Message, CallbackQuery, Update } from 'node-telegram-bot-api'

import { Driver }                from './models/Driver'
import { TripRequest, TripRequestDocument } from './models/TripRequest'

/*─────────────────────────────────────────────────────────────────────*/
/* 1 ▸ Rider‑bot instance                                             */
/*─────────────────────────────────────────────────────────────────────*/
const riderBot = new TelegramBot(process.env.RIDER_BOT_TOKEN!, {
  polling: false
})

// Poll in dev so /start & /ride work immediately:
if (process.env.NODE_ENV !== 'production') {
  riderBot.startPolling()
  console.log('⚡ rider bot polling started')
}

/*─────────────────────────────────────────────────────────────────────*/
/* 2 ▸ /start & /help for riders                                       */
/*─────────────────────────────────────────────────────────────────────*/
riderBot.onText(/^\/start$/, msg => {
  const chat = String(msg.chat.id)
  return riderBot.sendMessage(
    chat,
    '👋 Welcome to VayaRide Rider Bot!\nSend /ride to book a trip.',
    { parse_mode:'Markdown' }
  )
})

riderBot.onText(/^\/help$/, msg =>
  riderBot.sendMessage(
    msg.chat.id,
    '❓ *Help*\n' +
    '/ride – Book a ride\n' +
    '/help – Show this message',
    { parse_mode:'Markdown' }
  )
)

/*─────────────────────────────────────────────────────────────────────*/
/* 3 ▸ Ride‑request state                                              */
/*─────────────────────────────────────────────────────────────────────*/
type RideStep = 'ask_name' | 'ask_cname' | 'ask_dropoff' | 'ask_location'
const rideSession = new Map<string,RideStep>()

/*─────────────────────────────────────────────────────────────────────*/
/* 4 ▸ /ride – kick off booking                                         */
/*─────────────────────────────────────────────────────────────────────*/
riderBot.onText(/^\/ride$/, msg => {
  const chat = String(msg.chat.id)
  rideSession.set(chat,'ask_name')
  return riderBot.sendMessage(
    chat,
    '🚕 *Book a ride*\nWhat’s your *name*?',
    { parse_mode:'Markdown' }
  )
})

/*─────────────────────────────────────────────────────────────────────*/
/* 5 ▸ Collect name → contact → drop‑off → live‑location               */
/*─────────────────────────────────────────────────────────────────────*/
riderBot.on('message', async msg => {
  const chat = String(msg.chat.id)
  const step = rideSession.get(chat)
  if (!step) return
  if (!msg.text && !msg.location) return

  switch (step) {
    case 'ask_name':
      await TripRequest.create({ riderChatId:chat, riderName:msg.text!.trim(), status:'pending' })
      rideSession.set(chat,'ask_cname')
      return riderBot.sendMessage(
        chat,
        `📞 Thanks, *${msg.text!.trim()}*! Now send your *contact number*:`,
        { parse_mode:'Markdown', reply_markup:{ remove_keyboard:true } }
      )

    case 'ask_cname':
      await TripRequest.findOneAndUpdate(
        { riderChatId:chat,status:'pending',riderCName:{$exists:false} },
        { riderCName:msg.text!.trim() }
      )
      rideSession.set(chat,'ask_dropoff')
      return riderBot.sendMessage(chat,'🏁 Where would you like to go?',{ parse_mode:'Markdown' })

    case 'ask_dropoff':
      await TripRequest.findOneAndUpdate(
        { riderChatId:chat,status:'pending',dropoff:{$exists:false} },
        { dropoff:msg.text!.trim() }
      )
      rideSession.set(chat,'ask_location')
      return riderBot.sendMessage(
        chat,
        '📍 Please *share your live location* so drivers can find you:',
        {
          parse_mode:'Markdown',
          reply_markup:{
            keyboard:[[ { text:'Send location 📍', request_location:true } ]],
            one_time_keyboard:true,
            resize_keyboard:true
          }
        }
      )

    case 'ask_location':
      if (!msg.location) {
        return riderBot.sendMessage(chat,'❌ Tap “Send location 📍”')
      }
      const { latitude:lat, longitude:lon } = msg.location
      const trip = await TripRequest.findOneAndUpdate(
        {
          riderChatId:chat, status:'pending',
          dropoff:{$exists:true}, 'pickup.lat':{$exists:false}
        },
        { pickup:{lat,lon} },
        { new:true }
      ) as TripRequestDocument

      rideSession.delete(chat)
      await riderBot.sendMessage(chat,'⏳ Looking for drivers… please wait.')

      const drivers = await Driver.find({ status:'approved' }).lean()
      for (const d of drivers) {
        await riderBot.sendLocation(d.chatId,lat,lon)
        await riderBot.sendMessage(
          d.chatId,
          `🚨 *New ride request*\n👤 ${trip.riderName}\n📞 ${trip.riderCName}\n📍 ${trip.dropoff}`,
          {
            parse_mode:'Markdown',
            reply_markup:{ inline_keyboard:[[ { text:'Accept ✅', callback_data:`accept:${trip._id}` } ]] }
          }
        )
      }
      return
  }
})

/*─────────────────────────────────────────────────────────────────────*/
/* 6 ▸ Handle “Accept” & notify                                        */
/*─────────────────────────────────────────────────────────────────────*/
riderBot.on('callback_query', async cq => {
  if (!cq.data?.startsWith('accept:')) return
  const [,tripId] = cq.data.split(':')
  const driverChat = String(cq.from.id)

  const trip = await TripRequest.findByIdAndUpdate(tripId,{
    status:'accepted', driverChatId:driverChat
  }) as TripRequestDocument

  if (!trip) {
    return riderBot.answerCallbackQuery(cq.id,{ text:'❌ Trip not found' })
  }

  await riderBot.answerCallbackQuery(cq.id,{ text:'✅ You accepted!' })
  await riderBot.sendMessage(driverChat,`👍 Heading to pick up *${trip.riderName}*!`,{ parse_mode:'Markdown' })

  const driver = await Driver.findByChatId(driverChat)
  const info = driver ? `👤 ${driver.fullName}\n📞 ${driver.phone}` : '👤 Details unavailable'
  await riderBot.sendMessage(trip.riderChatId,`🚗 *Driver is coming!*\n${info}`,{ parse_mode:'Markdown' })
})

/*─────────────────────────────────────────────────────────────────────*/
/* 7 ▸ Relay live‑location updates                                     */
/*─────────────────────────────────────────────────────────────────────*/
riderBot.on('message', async m => {
  if (!m.location) return
  const riderChat = String(m.chat.id)
  const trip = await TripRequest.findOne({ riderChatId:riderChat, status:'accepted' }) as TripRequestDocument
  if (!trip?.driverChatId) return

  await riderBot.sendLocation(
    trip.driverChatId,
    m.location.latitude,
    m.location.longitude,
    m.location.live_period ? { live_period:m.location.live_period } : {}
  )
})

/*─────────────────────────────────────────────────────────────────────*/
/* 8 ▸ Named export for server.ts                                      */
/*─────────────────────────────────────────────────────────────────────*/
export const RiderPort = {
  processUpdate: (u:Update) => riderBot.processUpdate(u),
  setWebHook:    (url:string) => riderBot.setWebHook(url)
}
