// backend/riderPort.ts

import 'dotenv/config'
import TelegramBot, { Message, CallbackQuery } from 'node-telegram-bot-api'
import fetch                                  from 'node-fetch'

import { Driver }                from './models/Driver.js'
import { TripRequest }           from './models/TripRequest.js'
import { TripRequestDocument }   from './models/TripRequest.js'

/* ------------------------------------------------------------------
 * 1) Create a separate TelegramBot instance for riders
 * ------------------------------------------------------------------ */
const bot = new TelegramBot(process.env.RIDER_BOT_TOKEN!, {
  polling: false
})

/* ------------------------------------------------------------------
 * 2) Ride‑request session state
 * ------------------------------------------------------------------ */
type RideStep = 'ask_name' | 'ask_cname' | 'ask_dropoff' | 'ask_location'
const rideSession = new Map<string, RideStep>()

/* ------------------------------------------------------------------
 * 3) /ride – start the booking flow
 * ------------------------------------------------------------------ */
bot.onText(/^\/ride$/, msg => {
  const chat = String(msg.chat.id)
  rideSession.set(chat, 'ask_name')
  return bot.sendMessage(
    chat,
    '🚕 *Book a ride*\nWhat’s your *name*?',
    { parse_mode: 'Markdown' }
  )
})

/* ------------------------------------------------------------------
 * 4) Collect name → contact → dropoff → live location
 * ------------------------------------------------------------------ */
bot.on('message', async msg => {
  const chat = String(msg.chat.id)
  const step = rideSession.get(chat)
  if (!step) return
  if (!msg.text && !msg.location) return

  switch (step) {
    case 'ask_name':
      await TripRequest.create({
        riderChatId: chat,
        riderName:   msg.text!.trim(),
        status:      'pending'
      })
      rideSession.set(chat, 'ask_cname')
      return bot.sendMessage(chat,
        `📞 Thanks, *${msg.text!.trim()}*! Now send your *contact number*:`,
        { parse_mode:'Markdown', reply_markup:{ remove_keyboard:true } }
      )

    case 'ask_cname':
      await TripRequest.findOneAndUpdate(
        { riderChatId: chat, status:'pending', riderCName:{$exists:false} },
        { riderCName: msg.text!.trim() }
      )
      rideSession.set(chat, 'ask_dropoff')
      return bot.sendMessage(chat,
        '🏁 Where would you like to go? (e.g. “123 Main St”)',
        { parse_mode:'Markdown' }
      )

    case 'ask_dropoff':
      await TripRequest.findOneAndUpdate(
        { riderChatId: chat, status:'pending', dropoff:{$exists:false} },
        { dropoff: msg.text!.trim() }
      )
      rideSession.set(chat, 'ask_location')
      return bot.sendMessage(chat,
        '📍 Please *share your live location* so drivers can find you:',
        {
          parse_mode:'Markdown',
          reply_markup:{
            keyboard:[
              [{ text:'Send location 📍', request_location:true }]
            ],
            one_time_keyboard:true,
            resize_keyboard:true
          }
        }
      )

    case 'ask_location':
      if (!msg.location) {
        return bot.sendMessage(chat,'❌ Tap “Send location 📍”')
      }
      const { latitude: lat, longitude: lon } = msg.location
      const trip = await TripRequest.findOneAndUpdate(
        {
          riderChatId: chat,
          status:'pending',
          dropoff:{$exists:true},
          'pickup.lat':{$exists:false}
        },
        { pickup:{ lat, lon } },
        { new:true }
      ) as TripRequestDocument

      rideSession.delete(chat)

      // tell rider we're searching
      await bot.sendMessage(chat,'⏳ Looking for drivers… please wait.')

      // broadcast to all approved drivers
      const drivers = await Driver.find({ status:'approved' }).lean()
      for (const d of drivers) {
        await bot.sendLocation(d.chatId, lat, lon)
        await bot.sendMessage(
          d.chatId,
          `🚨 *New ride request*\n`+
          `👤 Rider: ${trip.riderName}\n`+
          `📞 ${trip.riderCName}\n`+
          `📍 Dropoff: ${trip.dropoff}`,
          {
            parse_mode:'Markdown',
            reply_markup:{
              inline_keyboard:[[
                { text:'Accept ✅', callback_data:`accept:${trip._id}` }
              ]]
            }
          }
        )
      }
      return
  }
})

/* ------------------------------------------------------------------
 * 5) Handle driver "Accept" button
 * ------------------------------------------------------------------ */
bot.on('callback_query', async cq => {
  if (!cq.data?.startsWith('accept:')) return
  const [, tripId] = cq.data.split(':')
  const driverChat = String(cq.from.id)

  const trip = await TripRequest.findByIdAndUpdate(tripId, {
    status:'accepted',
    driverChatId:driverChat
  }) as TripRequestDocument

  if (!trip) {
    return bot.answerCallbackQuery(cq.id,'❌ Trip not found')
  }

  // confirm to driver
  await bot.answerCallbackQuery(cq.id,'✅ You accepted!')
  await bot.sendMessage(driverChat,
    `👍 On your way to pick up *${trip.riderName}*!`,
    { parse_mode:'Markdown' }
  )

  // driver → rider
  const driver = await Driver.findByChatId(driverChat)
  const info = driver
    ? `👤 ${driver.fullName}\n📞 ${driver.phone}`
    : '👤 Details unavailable'

  await bot.sendMessage(trip.riderChatId,
    `🚗 *Driver is coming!*\n${info}`,
    { parse_mode:'Markdown' }
  )
})

/* ------------------------------------------------------------------
 * 6) Relay live‑location updates from rider → assigned driver
 * ------------------------------------------------------------------ */
bot.on('message', async m => {
  if (!m.location) return
  const riderChat = String(m.chat.id)

  const trip = await TripRequest.findOne({
    riderChatId:riderChat,
    status:     'accepted'
  }) as TripRequestDocument
  if (!trip?.driverChatId) return

  await bot.sendLocation(
    trip.driverChatId,
    m.location.latitude,
    m.location.longitude,
    m.location.live_period ? { live_period:m.location.live_period } : {}
  )
})

/* ------------------------------------------------------------------
 * Expose the two methods your server.ts expects
 * ------------------------------------------------------------------ */
export const RiderPort = {
  setWebHook: (url: string) =>
    bot.setWebHook(url),

  processUpdate: async (update: any) =>
    await bot.processUpdate(update)
}
