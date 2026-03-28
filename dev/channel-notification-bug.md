# Bug Report: Channel Notifications Not Surfaced To Claude Session

## Summary

Peer-to-peer message delivery works through the broker, but the receiving Claude session does not visibly surface the inbound message as a chat notification.

The `claude-peers` MCP servers register successfully, expose tools successfully, send messages successfully, and consume messages successfully. The missing behavior is the final host-side presentation of the `notifications/claude/channel` event to the model/session UI.

## Environment

- Repo: `claude-peers-mcp`
- Runtime: Node.js + `pnpm` + `tsx`
- MCP host observed: Codex / Claude host using stdio MCP transport
- Date observed: 2026-03-28

## Expected Behavior

When peer `A` sends a message to peer `B`, peer `B`'s running Claude session should receive and surface the message immediately as a channel notification.

## Actual Behavior

- `A -> B` message is accepted by the broker
- `B` polls the broker and marks the message as delivered
- `B` no longer has queued messages in `check_messages`
- no visible notification appears in the receiving Claude session

## What Was Verified

### MCP tool exposure

Both `Claude-Peers-A` and `Claude-Peers-B` expose and respond to tools successfully:

- `list_peers`
- `send_message`
- `set_summary`
- `check_messages`

### Broker registration

Both peer servers register with the broker successfully.

Observed broker-side peer IDs during live testing:

- `hbsdpqe5`
- `nyytzqcx`

### Live round-trip delivery

Two live messages were sent and confirmed in SQLite with `delivered=1`:

- `hbsdpqe5 -> nyytzqcx`
- `nyytzqcx -> hbsdpqe5`

This confirms:

- broker storage works
- broker polling works
- message dequeue/acknowledgement works

### Manual fallback path

After delivery, calling `check_messages` on both peers returns `No new messages.`

That matches the database state and confirms the messages were already consumed by the peer servers.

## Relevant Implementation Path

The receive path in `server.ts` is:

1. peer registers with broker in `main()`
2. polling loop calls `pollAndPushMessages()`
3. `pollAndPushMessages()` calls broker `/poll-messages`
4. returned messages are pushed via MCP notification method:
   - `notifications/claude/channel`

The message transport path is therefore functioning up to the MCP notification boundary.

## Likely Root Cause

The remaining failure surface appears to be host integration around `notifications/claude/channel`.

Most likely possibilities:

1. the host does not actually surface `notifications/claude/channel` into the active model/session UI
2. the notification method name or payload shape is slightly wrong for the host implementation
3. the capability advertisement under `experimental: { "claude/channel": {} }` is insufficient or mismatched for the client implementation
4. the host accepts the notification silently but does not route it into a visible chat event

## Supporting Evidence

The host logs show:

- peers starting successfully
- peers registering successfully
- MCP connections establishing successfully
- no `tools/list` failure for `Claude-Peers-A` / `Claude-Peers-B`

At the same time, the broker shows delivered messages and the peer tools show no queued messages left to read.

That combination strongly suggests the notification is emitted but not surfaced.

## Reproduction

1. Start two MCP peer sessions against the same broker.
2. Confirm both peers appear via `list_peers`.
3. Send a message from peer `A` to peer `B`.
4. Observe:
   - broker message row appears
   - row transitions to `delivered=1`
   - `check_messages` shows no queued messages afterward
   - no visible session notification appears for the human/model in `B`

## Suggested Next Investigation

1. Capture raw MCP traffic from the live `claude-peers` server and verify the exact `notifications/claude/channel` payload on the wire.
2. Compare the emitted notification shape against a known-working Claude channel implementation.
3. Verify whether the host requires a different capability declaration or notification method.
4. Test whether a different notification path is needed for Codex versus Claude Code.
