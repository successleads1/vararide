/**********************************************************************
 * routes/telegram.js  – Express router for Telegram webhooks
 * --------------------------------------------------------------------
 *  • Always responds in < 5 s so Telegram never shows “timeout”
 *  • Hands the raw update straight to node‑telegram‑bot‑api
 *********************************************************************/

import { Router } from 'express';
import { bot }    from '../bot.js';

export const telegramRouter = Router();

/* ------------------------------------------------------------------ */
/* POST  /telegram/webhook                                            */
/* ------------------------------------------------------------------ */
telegramRouter.post('/', (req, res) => {
  try {
    // 1) let node‑telegram‑bot‑api handle the update asynchronously
    bot.processUpdate(req.body);
  } catch (err) {
    // log, but NEVER throw – we must still return 200 to Telegram
    console.error('[telegramRouter] processUpdate failed:', err);
  }

  // 2) ACK immediately (Telegram requires HTTP 200 within ~10 s)
  res.sendStatus(200);
});
