// same shapes as the backend pydantic schemas

export type Role = "host" | "guest";

export interface Peer {
  id: string;
  name: string;
  role: Role;
}

export interface RoomCreated {
  code: string;
  name: string;
  join_url: string;
  host_secret: string;
  max_participants: number;
  lobby_enabled: boolean;
  expires_at: string;
}

export interface RoomPublic {
  code: string;
  name: string;
  max_participants: number;
  lobby_enabled: boolean;
  participants: number;
}

export interface JoinTicket {
  token: string;
  participant_id: string;
  role: Role;
  ws_path: string;
  expires_in: number;
  ice_servers: RTCIceServer[];
  // sfu mode (ch12), not used by this client yet
  media_mode?: "p2p" | "sfu";
  sfu_url?: string;
  sfu_token?: string;
}

// server -> client
export type ServerMessage =
  | {
      type: "welcome";
      you: Peer;
      peers: Peer[];
      lobby?: Peer[];
      room: { code: string; name: string; max_participants: number; lobby_enabled: boolean };
      sfu_token?: string;
      // back within the server's grace period: the others kept their connections to us
      rejoined?: boolean;
    }
  // rejoined: the same person back after a dropped connection (their call may still be running)
  | { type: "peer-joined"; peer: Peer; rejoined?: boolean }
  | { type: "peer-left"; peer_id: string }
  | { type: "offer" | "answer"; from: string; sdp: string }
  | { type: "ice"; from: string; candidate: RTCIceCandidateInit | null }
  | { type: "chat"; from: string; name: string; text: string; ts: number }
  | { type: "media-state"; from: string; audio: boolean; video: boolean }
  | { type: "lobby"; status: "waiting" }
  | { type: "lobby-request"; peer: Peer }
  | { type: "lobby-left"; peer_id: string }
  | { type: "denied" }
  | { type: "pong"; ts: number }
  | { type: "error"; code: string; message: string };

// client -> server
export type ClientMessage =
  | { type: "offer" | "answer"; to: string; sdp: string }
  | { type: "ice"; to: string; candidate: RTCIceCandidateInit | null }
  | { type: "chat"; text: string }
  | { type: "media-state"; audio: boolean; video: boolean }
  | { type: "admit" | "deny"; peer_id: string }
  | { type: "ping" };
