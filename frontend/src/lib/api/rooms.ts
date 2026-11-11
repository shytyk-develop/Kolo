import { inviteLink } from "../people";
import { ApiError, api, hostSecrets } from "./http";

export interface Room {
  code: string;
  link: string;
  lobby: boolean;
}

export interface CodeCheck {
  // lobby: knock and wait; open: straight in
  status: "open" | "lobby";
  code: string;
  // the person who made it, null if they didn't give a name
  host: string | null;
  participants: number;
}

// the backend names rooms "Room <code>" when the creator gave no name
export const hostName = (roomName: string) => (roomName && !roomName.startsWith("Room ") ? roomName : null);

/** "abc-defg-hij", "ABC DEFG HIJ" or a whole link: the code part (the backend normalizes the rest). */
export function codeFromInput(raw: string): string {
  const text = raw.trim();
  const fromLink = text.match(/\/r\/([^/?#\s]+)/);
  return decodeURIComponent(fromLink ? fromLink[1] : text);
}

export async function createRoom(opts: { lobby: boolean; name: string }): Promise<Room> {
  const room = await api.createRoom({ name: opts.name.trim() || undefined, lobby_enabled: opts.lobby });
  // the creator becomes the host
  hostSecrets.save(room.code, room.host_secret);
  return { code: room.code, link: inviteLink(room.code), lobby: room.lobby_enabled };
}

export async function checkCode(raw: string): Promise<CodeCheck> {
  const code = codeFromInput(raw);
  if (!code) throw new ApiError(404, "room_not_found", "Room not found");
  const room = await api.getRoom(code);
  // my own room: the host never waits
  const mine = Boolean(hostSecrets.get(room.code));
  return {
    status: room.lobby_enabled && !mine ? "lobby" : "open",
    code: room.code,
    host: hostName(room.name),
    participants: room.participants,
  };
}

/** Host only: waiting room on or off for people who join from now on. */
export async function setRoomLobby(code: string, on: boolean): Promise<boolean> {
  const secret = hostSecrets.get(code);
  if (!secret) throw new ApiError(403, "forbidden", "Only the host can change this room");
  const room = await api.updateRoom(code, { host_secret: secret, lobby_enabled: on });
  return room.lobby_enabled;
}
