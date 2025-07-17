/**********************************************************************
 * backend/jwt.js
 * Tiny helper around jsonwebtoken for driver‑dashboard links.
 * Runs only in the full Node runtime (never in Edge middleware).
 *********************************************************************/

import jwt from "jsonwebtoken";

const SECRET = process.env.DASH_JWT_SECRET;
if (!SECRET) throw new Error("DASH_JWT_SECRET missing in environment");

/**
 * Create a 30‑day dashboard link for a Telegram chatId.
 * @param {string} chatId
 * @returns {string} signed JWT
 */
export function signDashLink(chatId) {
  return jwt.sign({ chatId }, SECRET, { expiresIn: "30d" });
}

/**
 * Verify a JWT from vr_session cookie (throws if invalid/expired).
 * @param {string} token
 * @returns {{ chatId: string }}
 */
export function verifyJWT(token) {
  return /** @type {{ chatId: string }} */ (jwt.verify(token, SECRET));
}
