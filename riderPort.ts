// backend/riderPort.ts

import 'dotenv/config'
import TelegramBot, { Message, CallbackQuery, Update } from 'node-telegram-bot-api'
import fetch from 'node-fetch'

import { Driver, DriverDocument } from './models/Driver'
import { TripRequest, TripRequestDocument } from './models/TripRequest'

const riderBot = new TelegramBot(process.env.RIDER_BOT_TOKEN!, { polling: false })

type RideStep = 'ask_name' | 'ask_cname' | 'ask_dropoff' | 'ask_location'
const rideSession = new Map<string, RideStep>()

riderBot.onText(/^\/ride$/, msg => {
  const chat = String(msg.chat.id)
  rideSession.set(chat, 'ask_name')
  return riderBot.sendMessage(
    chat,
    '🚕 *Book a ride*\nWhat’s your *name*?',
    { parse_mode: 'Markdown' }
  )
})

riderBot.on('message', async msg => {
  const chat = String(msg.chat.id)
  const step = rideSession.get(chat)
  if (!step) return
  if (!msg.text && !msg.location) return

  switch (step) {
    case 'ask_name':
      await TripRequest.create({
        riderChatId: chat,
        riderName: msg.text!.trim(),
        status: 'pending'
      })
      rideSession.set(chat, 'ask_cname')
      return riderBot.sendMessage(chat,
        `📞 Thanks, *${msg.text!.trim()}*! Now send your *contact number*:`,
        { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
      )

    case 'ask_cname':
      await TripRequest.findOneAndUpdate(
        { riderChatId: chat, status: 'pending', riderCName: { $exists: false } },
        { riderCName: msg.text!.trim() }
      )
      rideSession.set(chat, 'ask_dropoff')
      return riderBot.sendMessage(chat,
        '🏁 Where would you like to go? (e.g. “123 Main St”)',
        { parse_mode: 'Markdown' }
      )

    case 'ask_dropoff':
      await TripRequest.findOneAndUpdate(
        { riderChatId: chat, status: 'pending', dropoff: { $exists: false } },
        { dropoff: msg.text!.trim() }
      )
      rideSession.set(chat, 'ask_location')
      return riderBot.sendMessage(chat,
        '📍 Please *share your live location* so drivers can find you:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [[{ text: 'Send location 📍', request_location: true }]],
            one_time_keyboard: true,
            resize_keyboard: true
          }
        }
      )

    case 'ask_location':
      if (!msg.location) {
        return riderBot.sendMessage(chat, '❌ Tap “Send location 📍”')
      }

      const { latitude: lat, longitude: lon } = msg.location
      const trip = await TripRequest.findOneAndUpdate(
        {
          riderChatId: chat,
          status: 'pending',
          dropoff: { $exists: true },
          'pickup.lat': { $exists: false }
        },
        { pickup: { lat, lon } },
        { new: true }
      ) as TripRequestDocument

      rideSession.delete(chat)
      await riderBot.sendMessage(chat, '⏳ Looking for drivers… please wait.')

      const drivers = await Driver.find({ status: 'approved' }).lean()
      for (const d of drivers) {
        await riderBot.sendLocation(d.chatId, lat, lon)
        await riderBot.sendMessage(
          d.chatId,
          `🚨 *New ride request*\n` +
          `👤 Rider: ${trip.riderName}\n` +
          `📞 ${trip.riderCName}\n` +
          `📍 Dropoff: ${trip.dropoff}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: 'Accept ✅', callback_data: `accept:${trip._id}` }
              ]]
            }
          }
        )
      }
      return
  }
})

riderBot.on('callback_query', async cq => {
  if (!cq.data?.startsWith('accept:')) return
  const [_, tripId] = cq.data.split(':')
  const driverChat = String(cq.from.id)

  const trip = await TripRequest.findByIdAndUpdate(tripId, {
    status: 'accepted',
    driverChatId: driverChat
  }) as TripRequestDocument

  if (!trip) {
    return riderBot.answerCallbackQuery(cq.id, { text: '❌ Trip not found' })
  }

  await riderBot.answerCallbackQuery(cq.id, { text: '✅ You accepted!' })
  await riderBot.sendMessage(driverChat,
    `👍 On your way to pick up *${trip.riderName}*!`,
    { parse_mode: 'Markdown' }
  )

  const driver = await Driver.findByChatId(driverChat)
  const info = driver
    ? `👤 ${driver.fullName}\n📞 ${driver.phone}`
    : '👤 Details unavailable'

  await riderBot.sendMessage(trip.riderChatId,
    `🚗 *Driver is coming!*\n${info}`,
    { parse_mode: 'Markdown' }
  )
})

riderBot.on('message', async m => {
  if (!m.location) return
  const riderChat = String(m.chat.id)
  const trip = await TripRequest.findOne({
    riderChatId: riderChat,
    status: 'accepted'
  }) as TripRequestDocument
  if (!trip?.driverChatId) return

  await riderBot.sendLocation(
    trip.driverChatId,
    m.location.latitude,
    m.location.longitude,
    m.location.live_period ? { live_period: m.location.live_period } : {}
  )
})

/* ------------------------------------------------------------------
 * EXPORT: Hook for webhook processing
 * ------------------------------------------------------------------ */
export const RiderPort = {
  processUpdate: (update: Update) => riderBot.processUpdate(update),
  setWebHook: async (url: string) => {
    await riderBot.setWebHook(url)
  }
}
