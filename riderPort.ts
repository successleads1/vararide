// backend/riderPort.ts
import TelegramBot from 'node-telegram-bot-api';
import { TripRequest } from './models/TripRequest';
import { Driver }      from './models/Driver';

// instantiate with your Rider token
export const RiderPort = new TelegramBot(
  process.env.RIDER_PORT_TOKEN!,
  { polling: false }
);

type RideStep = 'ask_name' | 'ask_dropoff' | 'ask_location';
const rideSession = new Map<string, RideStep>();

// 1) /ride → ask name
RiderPort.onText(/^\/ride$/, async msg => {
  const chat = String(msg.chat.id);
  rideSession.set(chat, 'ask_name');
  await RiderPort.sendMessage(
    chat,
    '🚕 *Book a ride*\nWhat’s your name?',
    { parse_mode: 'Markdown' }
  );
});

// 2) collect name → dropoff → location
RiderPort.on('message', async msg => {
  const chat = String(msg.chat.id);
  const step = rideSession.get(chat);
  if (!step) return;
  if (!msg.text && !msg.location) return;

  switch (step) {
    case 'ask_name':
      await TripRequest.create({
        riderChatId: chat,
        riderName:   msg.text!,
        pickup:      { lat: 0, lon: 0 },
      });
      rideSession.set(chat, 'ask_dropoff');
      return RiderPort.sendMessage(chat, 'Where would you like to go?');

    case 'ask_dropoff':
      await TripRequest.findOneAndUpdate(
        { riderChatId: chat, status: 'pending', 'pickup.lat': 0 },
        { dropoff: msg.text! }
      );
      rideSession.set(chat, 'ask_location');
      return RiderPort.sendMessage(
        chat,
        'Please *share your current location*:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [[{ text: 'Send location 📍', request_location: true }]],
            one_time_keyboard: true
          }
        }
      );

    case 'ask_location':
      if (!msg.location) {
        return RiderPort.sendMessage(chat, '❌ Tap “Send location 📍”');
      }
      const { latitude: lat, longitude: lon } = msg.location!;
      const trip = await TripRequest.findOneAndUpdate(
        { riderChatId: chat, status: 'pending', 'pickup.lat': 0 },
        { 'pickup.lat': lat, 'pickup.lon': lon },
        { new: true }
      );
      rideSession.delete(chat);

      await RiderPort.sendMessage(chat, '✅ Got it! Looking for a driver…');

      // broadcast to all approved drivers
      const drivers = await Driver.find({ status: 'approved' }).lean();
      for (const d of drivers) {
        await RiderPort.sendLocation(d.chatId, lat, lon);
        await RiderPort.sendMessage(
          d.chatId,
          `🚨 *New ride request*\n👤 ${trip!.riderName}\n📍 Drop:\ ${trip!.dropoff}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: 'Accept ✅', callback_data: `accept:${trip!._id}` }
              ]]
            }
          }
        );
      }
      return;
  }
});

// 3) handle “Accept” buttons
RiderPort.on('callback_query', async cq => {
  const [ action, tripId ] = cq.data!.split(':');
  if (action !== 'accept') return;

  const driverChat = String(cq.from.id);
  const trip = await TripRequest.findByIdAndUpdate(tripId, {
    status:       'accepted',
    driverChatId: driverChat
  });
  if (!trip) return RiderPort.answerCallbackQuery(cq.id, '❌ Trip not found');

  await RiderPort.answerCallbackQuery(cq.id, 'You’ve accepted!');
  await RiderPort.sendMessage(driverChat, `👍 On your way to ${trip.riderName}`);
  await RiderPort.sendMessage(
    trip.riderChatId,
    `🚗 *Driver is coming!*\nContact: @${cq.from.username || cq.from.first_name}`,
    { parse_mode: 'Markdown' }
  );
});
