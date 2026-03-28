/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   pnpm run cli -- status          - Show broker status and all peers
 *   pnpm run cli -- peers           - List all peers
 *   pnpm run cli -- send <id> <msg> - Send a message to a peer
 *   pnpm run cli -- kill-broker     - Stop the broker daemon
 */

import type {
  BrokerMutationResponse,
  HealthResponse,
  ListPeersRequest,
  Peer,
} from "./shared/types.ts";

/** Port used by the local broker daemon. */
const BROKER_PORT = Number.parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);

/** Base URL for local broker HTTP requests. */
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

/** Static caller context used by CLI requests that are not tied to a peer registration. */
const MACHINE_SCOPE_REQUEST: ListPeersRequest = {
  scope: "machine",
  cwd: "/",
  git_root: null,
};

/** Current top-level CLI command. */
const cmd = process.argv[2];

/** Format one peer record for terminal output. */
function renderPeer(peer: Peer): string {
  const lines = [`  ${peer.id}  PID:${peer.pid}  ${peer.cwd}`];
  if (peer.summary) {
    lines.push(`         ${peer.summary}`);
  }
  if (peer.tty) {
    lines.push(`         TTY: ${peer.tty}`);
  }
  lines.push(`         Last seen: ${peer.last_seen}`);
  return lines.join("\n");
}

/** Call a broker endpoint and decode the JSON response body. */
async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const options: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};

  const res = await fetch(`${BROKER_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(3_000),
  });

  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}

/** Show broker health and the currently registered peers. */
async function showStatus(): Promise<void> {
  try {
    // Start with health so the output explains whether the broker is reachable at all.
    const health = await brokerFetch<HealthResponse>("/health");
    console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
    console.log(`URL: ${BROKER_URL}`);

    if (health.peers === 0) {
      return;
    }

    // Expand the health summary with the current peer list when registrations exist.
    const peers = await brokerFetch<Peer[]>("/list-peers", MACHINE_SCOPE_REQUEST);
    console.log("\nPeers:");
    for (const peer of peers) {
      console.log(renderPeer(peer));
    }
  } catch {
    console.log("Broker is not running.");
  }
}

/** Show just the currently registered peers. */
async function showPeers(): Promise<void> {
  try {
    const peers = await brokerFetch<Peer[]>("/list-peers", MACHINE_SCOPE_REQUEST);

    if (peers.length === 0) {
      console.log("No peers registered.");
      return;
    }

    for (const peer of peers) {
      console.log(renderPeer(peer));
    }
  } catch {
    console.log("Broker is not running.");
  }
}

/** Send a message into a registered Claude session. */
async function sendCliMessage(): Promise<void> {
  const toId = process.argv[3];
  const message = process.argv.slice(4).join(" ");

  // Fail fast when the command line is incomplete so we do not hit the broker with junk.
  if (!toId || !message) {
    console.error("Usage: pnpm run cli -- send <peer-id> <message>");
    process.exitCode = 1;
    return;
  }

  try {
    const result = await brokerFetch<BrokerMutationResponse>("/send-message", {
      from_id: "cli",
      to_id: toId,
      text: message,
    });

    if (!result.ok) {
      console.error(`Failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Message sent to ${toId}`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/** Ask the broker to shut itself down gracefully. */
async function killBroker(): Promise<void> {
  try {
    // Report the current broker state before we request shutdown.
    const health = await brokerFetch<HealthResponse>("/health");
    console.log(`Broker has ${health.peers} peer(s). Shutting down...`);

    const result = await brokerFetch<BrokerMutationResponse>("/shutdown", {});
    if (!result.ok) {
      console.error(`Failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }

    console.log("Broker stopped.");
  } catch {
    console.log("Broker is not running.");
  }
}

/** Print the supported CLI commands. */
function printUsage(): void {
  console.log(`claude-peers CLI

Usage:
  pnpm run cli -- status          Show broker status and all peers
  pnpm run cli -- peers           List all peers
  pnpm run cli -- send <id> <msg> Send a message to a peer
  pnpm run cli -- kill-broker     Stop the broker daemon`);
}

/** Dispatch the requested top-level CLI command. */
async function main(): Promise<void> {
  switch (cmd) {
    case "status":
      await showStatus();
      return;
    case "peers":
      await showPeers();
      return;
    case "send":
      await sendCliMessage();
      return;
    case "kill-broker":
      await killBroker();
      return;
    default:
      printUsage();
  }
}

await main();
