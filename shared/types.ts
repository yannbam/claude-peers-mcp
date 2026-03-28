/** Discovery scopes supported by the broker's peer listing API. */
export type PeerScope = "machine" | "directory" | "repo";

/** Unique identifier assigned to a registered Claude Code instance. */
export type PeerId = string;

/** Metadata the broker keeps for each active Claude Code instance. */
export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
}

/** A message queued or delivered between two peer sessions. */
export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string;
  delivered: boolean;
}

/** Payload used when a server instance registers itself with the broker. */
export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

/** Broker response returned after a successful registration. */
export interface RegisterResponse {
  id: PeerId;
}

/** Payload used to keep an existing peer registration alive. */
export interface HeartbeatRequest {
  id: PeerId;
}

/** Payload used to update a peer's advertised work summary. */
export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

/** Payload used to list visible peers for a given caller context. */
export interface ListPeersRequest {
  scope: PeerScope;
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

/** Payload used to enqueue a message for another peer. */
export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

/** Payload used to fetch any currently undelivered messages for a peer. */
export interface PollMessagesRequest {
  id: PeerId;
}

/** Broker response that returns newly available peer messages. */
export interface PollMessagesResponse {
  messages: Message[];
}

/** Lightweight broker status returned by the local health endpoint. */
export interface HealthResponse {
  status: "ok";
  peers: number;
}

/** Common acknowledgement shape for broker mutations. */
export interface BrokerMutationResponse {
  ok: boolean;
  error?: string;
}
