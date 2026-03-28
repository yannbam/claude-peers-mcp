/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "pnpm", "args": ["exec", "tsx", "./server.ts"] } }
 */

import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFileText } from "./shared/subprocess.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";
import type {
  Peer,
  PeerId,
  PeerScope,
  PollMessagesResponse,
  RegisterResponse,
} from "./shared/types.ts";

/** Port used by the local broker daemon. */
const BROKER_PORT = Number.parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);

/** Base URL for broker API requests. */
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

/** Poll cadence for inbound peer messages. */
const POLL_INTERVAL_MS = 1_000;

/** Heartbeat cadence that keeps broker registrations alive. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Project root that contains the broker entrypoint and local dev dependencies. */
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the broker entrypoint. */
const BROKER_SCRIPT = fileURLToPath(new URL("./broker.ts", import.meta.url));

/** Platform-aware path to the locally installed tsx launcher. */
const TSX_BINARY = join(
  PROJECT_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx"
);

/** Shared MCP server instance for the stdio transport. */
const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder - answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

/** Tool descriptors exposed to Claude Code. */
const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
] as const;

/** Broker-issued peer ID for the current Claude session. */
let myId: PeerId | null = null;

/** Current working directory for the Claude session that owns this MCP process. */
let myCwd = process.cwd();

/** Git root for the owning Claude session, if the cwd is inside a repository. */
let myGitRoot: string | null = null;

/** Guard that prevents duplicate unregister attempts during shutdown. */
let cleaningUp = false;

/** Emit server diagnostics on stderr so stdout remains pure MCP traffic. */
function log(message: string): void {
  console.error(`[claude-peers] ${message}`);
}

/** Wrap a plain text string in the MCP tool response envelope. */
function createTextResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

// Wire the advertised tool capability to concrete MCP handlers before the transport connects.
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Route tool calls into the local broker-backed peer operations.
mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: PeerScope }).scope;

      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return createTextResult(`No other Claude Code instances found (scope: ${scope}).`);
        }

        // Render peers in a copy/paste-friendly block for terminal users and agents alike.
        const lines = peers.map((peer) => {
          const parts = [`ID: ${peer.id}`, `PID: ${peer.pid}`, `CWD: ${peer.cwd}`];
          if (peer.git_root) {
            parts.push(`Repo: ${peer.git_root}`);
          }
          if (peer.tty) {
            parts.push(`TTY: ${peer.tty}`);
          }
          if (peer.summary) {
            parts.push(`Summary: ${peer.summary}`);
          }
          parts.push(`Last seen: ${peer.last_seen}`);
          return parts.join("\n  ");
        });

        return createTextResult(
          `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`
        );
      } catch (error) {
        return createTextResult(
          `Error listing peers: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return createTextResult("Not registered with broker yet", true);
      }

      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });

        if (!result.ok) {
          return createTextResult(`Failed to send: ${result.error}`, true);
        }

        return createTextResult(`Message sent to peer ${to_id}`);
      } catch (error) {
        return createTextResult(
          `Error sending message: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return createTextResult("Not registered with broker yet", true);
      }

      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return createTextResult(`Summary updated: "${summary}"`);
      } catch (error) {
        return createTextResult(
          `Error setting summary: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    }

    case "check_messages": {
      if (!myId) {
        return createTextResult("Not registered with broker yet", true);
      }

      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

        if (result.messages.length === 0) {
          return createTextResult("No new messages.");
        }

        const lines = result.messages.map(
          (message) => `From ${message.from_id} (${message.sent_at}):\n${message.text}`
        );
        return createTextResult(
          `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`
        );
      } catch (error) {
        return createTextResult(
          `Error checking messages: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

/** Call one JSON-based broker endpoint. */
async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Broker error (${path}): ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as T;
}

/** Probe the broker health endpoint. */
async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the broker in the background when this is the first active MCP server. */
async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const brokerProcess = spawn(TSX_BINARY, [BROKER_SCRIPT], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
    env: process.env,
  });
  let spawnError: Error | null = null;

  // Surface startup failures explicitly instead of timing out with no clue why.
  brokerProcess.once("error", (error) => {
    spawnError = error;
  });
  brokerProcess.unref();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (spawnError) {
      throw spawnError;
    }
    await delay(200);
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }

  throw new Error("Failed to start broker daemon after 6 seconds");
}

/** Resolve the git root for one working directory. */
async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const result = await execFileText("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeoutMs: 3_000,
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Best-effort TTY lookup for the parent Claude process. */
function getTty(): string | null {
  try {
    if (!process.ppid) {
      return null;
    }

    // Ask the OS for the parent's controlling terminal so peers can distinguish sessions.
    const stdout = execFileSync("ps", ["-o", "tty=", "-p", String(process.ppid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const tty = stdout.trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

/** Poll pending messages and forward them into Claude's channel transport. */
async function pollAndPushMessages(): Promise<void> {
  if (!myId) {
    return;
  }

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    if (result.messages.length === 0) {
      return;
    }

    let sendersById = new Map<string, Peer>();
    try {
      // Fetch sender metadata once per poll cycle so channel notifications include useful context.
      const peers = await brokerFetch<Peer[]>("/list-peers", {
        scope: "machine",
        cwd: myCwd,
        git_root: myGitRoot,
      });
      sendersById = new Map(peers.map((peer) => [peer.id, peer]));
    } catch {
      // Peer metadata is nice-to-have; missing it should not block message delivery.
    }

    for (const message of result.messages) {
      const sender = sendersById.get(message.from_id);

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: message.text,
          meta: {
            from_id: message.from_id,
            from_summary: sender?.summary ?? "",
            from_cwd: sender?.cwd ?? "",
            sent_at: message.sent_at,
          },
        },
      });

      log(`Pushed message from ${message.from_id}: ${message.text.slice(0, 80)}`);
    }
  } catch (error) {
    log(`Poll error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Unregister the current peer before the MCP process exits. */
async function cleanup(): Promise<void> {
  if (cleaningUp) {
    return;
  }

  cleaningUp = true;

  if (myId) {
    try {
      await brokerFetch("/unregister", { id: myId });
      log("Unregistered from broker");
    } catch {
      // Best effort during shutdown.
    }
  }

  process.exit(0);
}

/** Start the MCP server, register with the broker, and begin background polling. */
async function main(): Promise<void> {
  // Make sure the machine-local broker exists before we try to register this peer.
  await ensureBroker();

  // Snapshot the local execution context that other peers need for discovery.
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      // Gather lightweight git context before asking the model for a startup summary.
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });

      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (error) {
      log(`Auto-summary failed (non-critical): ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  // Give the summary a short head start without holding up broker registration.
  await Promise.race([summaryPromise, delay(3_000)]);

  const registration = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
  });
  myId = registration.id;
  log(`Registered as peer ${myId}`);

  if (!initialSummary) {
    void summaryPromise.then(async () => {
      if (!initialSummary || !myId) {
        return;
      }

      try {
        await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
        log(`Late auto-summary applied: ${initialSummary}`);
      } catch {
        // Late summary updates are best-effort.
      }
    });
  }

  // Attach stdio only after registration so inbound messages can start flowing immediately.
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const pollTimer = setInterval(() => {
    void pollAndPushMessages();
  }, POLL_INTERVAL_MS);

  const heartbeatTimer = setInterval(() => {
    // Keep the registration fresh without letting a transient broker hiccup kill the server.
    if (!myId) {
      return;
    }

    void brokerFetch("/heartbeat", { id: myId }).catch(() => {
      // Heartbeat failures are non-critical because the next cycle will retry.
    });
  }, HEARTBEAT_INTERVAL_MS);

  // Make shutdown tidy so dead peers disappear promptly instead of waiting for stale-peer cleanup.
  const stop = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    await cleanup();
  };

  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}

// Fail loudly on startup errors because a half-started MCP server is not useful.
main().catch((error) => {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
