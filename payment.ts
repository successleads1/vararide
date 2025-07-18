import { Router } from 'express';
import { Driver } from './models/Driver'; // Assuming you're using Driver model
import { bot } from './bot'; // Assuming you have the bot instance

const paymentRouter = Router();

// Mock PayFast payment handler
paymentRouter.post('/generate-payment-link', async (req, res) => {
  const { chatId, amount } = req.body; // Payment details: chatId and amount
  
  const driver = await Driver.findByChatId(chatId); // Fetch user details (driver)

  if (!driver) {
    return res.status(404).json({ error: 'Driver not found' });
  }

  // Simulate creating a payment link (this will be the mock link for now)
  const paymentLink = `https://mock-payment.com/pay/${chatId}?amount=${amount}`;

  // Send the payment link to the user via Telegram bot
  await bot.sendMessage(chatId, `💰 Please click the link below to make a payment of ${amount} ZAR:\n${paymentLink}`);

  return res.status(200).json({ message: 'Payment link sent to the user', paymentLink });
});

export { paymentRouter };
