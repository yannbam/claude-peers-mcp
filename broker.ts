/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: pnpm run broker
 */

import { randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Database from "better-sqlite3";
import type {
  BrokerMutationResponse,
  HeartbeatRequest,
  ListPeersRequest,
  Message,
  Peer,
  PollMessagesRequest,
  PollMessagesResponse,
  RegisterRequest,
  RegisterResponse,
  SendMessageRequest,
  SetSummaryRequest,
} from "./shared/types.ts";

/** SQLite row shape for queued messages before boolean normalization. */
interface MessageRecord extends Omit<Message, "delivered"> {
  delivered: number;
}

/** Port used by the localhost broker daemon. */
const PORT = Number.parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);

/** Database file path for broker state. */
const DB_PATH = resolveDbPath(
  process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.claude-peers.db`
);

/** Shared SQLite connection for broker state. */
const db = new Database(DB_PATH);

// Keep the broker responsive under concurrent local access without changing the persistence model.
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 3000");

// Materialize the broker schema up front so request handlers can stay focused on routing.
db.exec(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  );
`);

/** Prepared statement that inserts a newly registered peer. */
const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

/** Prepared statement that refreshes a peer heartbeat timestamp. */
const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

/** Prepared statement that updates a peer summary. */
const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

/** Prepared statement that removes a peer registration. */
const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

/** Prepared statement that lists every registered peer. */
const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

/** Prepared statement that lists peers by exact working directory. */
const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

/** Prepared statement that lists peers by git root. */
const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

/** Prepared statement that finds an existing peer registration for one PID. */
const selectPeerIdByPid = db.prepare(`
  SELECT id FROM peers WHERE pid = ?
`);

/** Prepared statement that lists the peer IDs and PIDs used for stale-process cleanup. */
const selectPeerIds = db.prepare(`
  SELECT id, pid FROM peers
`);

/** Prepared statement that finds a single peer by ID. */
const selectPeerIdById = db.prepare(`
  SELECT id FROM peers WHERE id = ?
`);

/** Prepared statement that inserts a queued message. */
const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

/** Prepared statement that lists pending messages for one peer. */
const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

/** Prepared statement that marks a queued message as delivered. */
const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

/** Prepared statement that drops pending messages targeting a stale peer. */
const deletePendingMessagesForPeer = db.prepare(`
  DELETE FROM messages WHERE to_id = ? AND delivered = 0
`);

/** Guard that prevents duplicate shutdown work. */
let shuttingDown = false;

/** Expand a user-supplied database path into an absolute filesystem path. */
function resolveDbPath(dbPath: string): string {
  if (dbPath === "~") {
    return process.env.HOME ?? process.env.USERPROFILE ?? dbPath;
  }
  if (dbPath.startsWith("~/") || dbPath.startsWith("~\\")) {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE;
    if (homeDir) {
      return `${homeDir}${dbPath.slice(1)}`;
    }
  }
  return dbPath;
}

/** Serialize a JSON response with a predictable content type. */
function writeJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Read and parse a JSON request body. */
async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  // Buffer the full request body before parsing so handlers can stay synchronous.
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return (text ? JSON.parse(text) : {}) as T;
}

/** Convert one SQLite message row into the typed API shape. */
function normalizeMessage(record: MessageRecord): Message {
  return {
    ...record,
    delivered: Boolean(record.delivered),
  };
}

/** Generate a short peer ID that is readable in terminal output. */
function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";

  // Keep IDs compact enough for copy/paste while still avoiding routine collisions.
  for (let index = 0; index < 8; index += 1) {
    id += chars[randomInt(chars.length)];
  }

  return id;
}

/** Remove peer registrations whose owning processes no longer exist. */
function cleanStalePeers(): void {
  const peers = selectPeerIds.all() as Array<{ id: string; pid: number }>;

  for (const peer of peers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      deletePeer.run(peer.id);
      deletePendingMessagesForPeer.run(peer.id);
    }
  }
}

/** Register a new Claude session with the broker. */
function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  const existing = selectPeerIdByPid.get(body.pid) as { id: string } | undefined;

  // Re-registering the same PID should replace its previous identity cleanly.
  if (existing) {
    deletePeer.run(existing.id);
    deletePendingMessagesForPeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now);
  return { id };
}

/** Refresh the heartbeat timestamp for an already registered peer. */
function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

/** Persist a new summary for one peer. */
function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

/** List peers visible from the caller's requested scope. */
function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  // Match the caller's requested visibility scope before doing stale-process cleanup.
  switch (body.scope) {
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      peers = body.git_root
        ? (selectPeersByGitRoot.all(body.git_root) as Peer[])
        : (selectPeersByDirectory.all(body.cwd) as Peer[]);
      break;
    case "machine":
    default:
      peers = selectAllPeers.all() as Peer[];
      break;
  }

  if (body.exclude_id) {
    peers = peers.filter((peer) => peer.id !== body.exclude_id);
  }

  // Drop dead peers lazily so callers never see registrations backed by dead processes.
  return peers.filter((peer) => {
    try {
      process.kill(peer.pid, 0);
      return true;
    } catch {
      deletePeer.run(peer.id);
      deletePendingMessagesForPeer.run(peer.id);
      return false;
    }
  });
}

/** Queue a message for later delivery to another peer. */
function handleSendMessage(body: SendMessageRequest): BrokerMutationResponse {
  const target = selectPeerIdById.get(body.to_id) as { id: string } | undefined;

  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

/** Fetch and mark all pending messages for one peer. */
function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const records = selectUndelivered.all(body.id) as MessageRecord[];

  // Mark first-read messages as delivered before we hand them back to the caller.
  for (const record of records) {
    markDelivered.run(record.id);
  }

  return { messages: records.map(normalizeMessage) };
}

/** Remove one peer registration explicitly on process exit. */
function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

/** Schedule a graceful broker shutdown. */
function handleShutdown(): BrokerMutationResponse {
  setImmediate(() => shutdownBroker("shutdown requested"));
  return { ok: true };
}

/** Close the HTTP server and SQLite connection exactly once. */
function shutdownBroker(reason: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(stalePeerTimer);
  console.error(`[claude-peers broker] shutting down (${reason})`);

  server.close(() => {
    db.close();
    process.exit(0);
  });
}

// Clear stale registrations once at startup so the first client sees a clean registry.
cleanStalePeers();

/** Background cleanup timer that reaps dead peers. */
const stalePeerTimer = setInterval(cleanStalePeers, 30_000);
stalePeerTimer.unref();

/** Shared HTTP server that exposes the broker API on localhost. */
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  // Keep the health endpoint cheap and available without requiring a POST body.
  if (req.method !== "POST") {
    if (url.pathname === "/health") {
      writeJson(res, { status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("claude-peers broker");
    return;
  }

  try {
    switch (url.pathname) {
      case "/register":
        writeJson(res, handleRegister(await readJsonBody<RegisterRequest>(req)));
        return;
      case "/heartbeat":
        handleHeartbeat(await readJsonBody<HeartbeatRequest>(req));
        writeJson(res, { ok: true });
        return;
      case "/set-summary":
        handleSetSummary(await readJsonBody<SetSummaryRequest>(req));
        writeJson(res, { ok: true });
        return;
      case "/list-peers":
        writeJson(res, handleListPeers(await readJsonBody<ListPeersRequest>(req)));
        return;
      case "/send-message":
        writeJson(res, handleSendMessage(await readJsonBody<SendMessageRequest>(req)));
        return;
      case "/poll-messages":
        writeJson(res, handlePollMessages(await readJsonBody<PollMessagesRequest>(req)));
        return;
      case "/unregister":
        handleUnregister(await readJsonBody<{ id: string }>(req));
        writeJson(res, { ok: true });
        return;
      case "/shutdown":
        writeJson(res, handleShutdown());
        return;
      default:
        writeJson(res, { error: "not found" }, 404);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(res, { error: message }, 500);
  }
});

// Listen on localhost only because this broker is machine-local coordination, not a network service.
server.listen(PORT, "127.0.0.1", () => {
  console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
});

// Mirror the CLI shutdown path for direct process signals.
process.once("SIGINT", () => shutdownBroker("SIGINT"));
process.once("SIGTERM", () => shutdownBroker("SIGTERM"));
