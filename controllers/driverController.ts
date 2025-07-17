import { Driver } from "../models/Driver.js";
import { io } from "../server.js";
export const push = (ev: string, data: any) => io.emit(ev, data);
export const startSession = async (chatId: string, u?: string) =>
  (await Driver.findOne({ chatId })) ||
  Driver.create({ chatId, telegramUsername: u });
export const saveName = (chatId: string, n: string) =>
  Driver.findOneAndUpdate(
    { chatId },
    { fullName: n, registrationStep: "phone" },
    { new: true }
  ).then((d) => (push("driver_basic", d), d));
export const savePhone = (chatId: string, p: string) =>
  Driver.findOneAndUpdate(
    { chatId },
    { phone: p, registrationStep: "docs" },
    { new: true }
  ).then((d) => (push("driver_basic", d), d));
export const completeRegistration = (chatId: string) =>
  Driver.findOneAndUpdate(
    { chatId },
    { registrationStep: "completed", status: "pending" },
    { new: true }
  ).then((d) => (push("driver_registered", d), d));
