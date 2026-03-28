---
description: Use Node.js 22+ with pnpm and tsx for claude-peers.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` - Singleton HTTP daemon on localhost:7899 backed by SQLite. Auto-launched by the MCP server.
- `server.ts` - MCP stdio server, one per Claude Code instance. Connects to the broker, exposes tools, pushes channel notifications.
- `shared/types.ts` - Shared broker and peer protocol types.
- `shared/summarize.ts` - Auto-summary generation via gpt-5.4-nano.
- `cli.ts` - CLI utility for inspecting broker state.

## Running

```bash
pnpm install

# Start Claude Code with the channel:
claude --dangerously-load-development-channels server:claude-peers

# Or add to .mcp.json and run as a regular MCP server:
# { "claude-peers": { "command": "pnpm", "args": ["exec", "tsx", "./server.ts"] } }

# CLI:
pnpm run cli -- status
pnpm run cli -- peers
pnpm run cli -- send <peer-id> <message>
pnpm run cli -- kill-broker
```

## Tooling

- Use `pnpm`, not `npm`.
- Run TypeScript entrypoints through `tsx`.
- Prefer Node built-ins for HTTP, fetch, timers, and child processes.
- Use `better-sqlite3` for SQLite in this project because `node:sqlite` is still experimental in the target runtime.

## Testing

```bash
pnpm run typecheck
pnpm test
```
