import { ApiError } from "./http";

// websocket close codes from the backend, as the same errors http gives
const CLOSES: Record<number, [string, string]> = {
  4401: ["unauthorized", "The link has expired"],
  4403: ["forbidden", "You can’t join this meeting"],
  4404: ["room_not_found", "Room not found"],
  4409: ["room_full", "Room is full"],
  4410: ["room_expired", "Room has expired"],
};

export function closeError(code: number): ApiError {
  const [name, message] = CLOSES[code] ?? ["unreachable", "Lost the connection to kolo"];
  return new ApiError(code, name, message);
}

/** What to tell people when a request fails. Never the raw browser text. */
export function errorText(err: unknown, fallback = "Something went wrong. Try again."): string {
  if (!(err instanceof ApiError)) return fallback;
  switch (err.code) {
    case "offline":
      return "You’re offline. Check your connection and try again.";
    case "unreachable":
    case "timeout":
      return "Can’t reach kolo right now. Try again in a moment.";
    case "room_not_found":
      return "No room with this code. Check it or ask for a new link.";
    case "room_expired":
      return "This meeting has ended. Ask for a new link.";
    case "room_full":
      return "This room is full.";
    case "rate_limited":
      return "Too many new rooms. Wait a minute and try again.";
    case "forbidden":
      return "Only the host can do that.";
    case "unauthorized":
      return "This invite has expired. Join again.";
    case "denied":
    case "not_available":
      return err.message;
    case "invite_rate_limited":
      return "Too many invites, try again later.";
    case "telegram_not_linked":
      return "Connect Telegram in Settings first.";
    case "telegram_unavailable":
      return "Telegram isn’t answering. Try again in a moment.";
    case "telegram_disabled":
      return "Telegram invites aren’t set up here.";
    case "link_not_found":
      return "That Telegram link expired. Try again.";
    case "invalid_input":
      return err.message;
  }
  if (err.status >= 500) return "kolo is having trouble right now. Try again in a moment.";
  return fallback;
}

// the room is gone for good: no point trying again
export const roomGone = (err: unknown) =>
  err instanceof ApiError && (err.code === "room_not_found" || err.code === "room_expired");
