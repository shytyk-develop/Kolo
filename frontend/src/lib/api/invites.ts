import { ApiError } from "./http";

export interface InviteReceipt {
  contactId: string;
  code: string;
  via: "telegram";
  sentAt: number;
}

// TODO(telegram): there's no backend for telegram invites yet. When the bot exists: send the
// invite here, flip TELEGRAM_READY, and the plane buttons, "Send via Telegram" and screen 03 come back
export const TELEGRAM_READY = false;

export async function sendTelegramInvite(contactId: string, code: string): Promise<InviteReceipt> {
  void contactId;
  void code;
  throw new ApiError(501, "not_available", "Telegram invites are coming soon");
}
