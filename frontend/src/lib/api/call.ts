import { api } from "./http";
import type { RoomPublic } from "../types";

// waits between tries to get a dropped call back
export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 8000];
export const RECONNECT_ATTEMPTS = RECONNECT_DELAYS.length;

/** One try: kolo answers and the room is still there. The call page then takes the seat back. */
export function reconnect(code: string): Promise<RoomPublic> {
  return api.getRoom(code);
}
