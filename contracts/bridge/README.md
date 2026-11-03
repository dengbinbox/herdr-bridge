# Bridge wire protocol v1

The agent initiates a WebSocket at `/bridge/v1/connect`. Authentication is an
`Authorization: Bearer hbk_<public>_<secret>` header, never a URL parameter.
The public portion is 9 random bytes encoded as 12 base64url characters; the
secret is 32 random bytes encoded as 43 base64url characters. Split at the
fixed public length, since underscores are valid base64url characters.

Text messages are UTF-8 JSON, limited to 16 KiB, described in
`control.schema.json`. Unknown optional properties are permitted; unknown
message types and major versions are rejected. UUID strings must be lowercase,
canonical, nonzero UUIDs. Capabilities include `core-stream-v1`.

1. Send `register` within 10 seconds. The server replies `registered` with a
   fresh `connection_id`, negotiated bounds and heartbeat durations in ms.
2. WebSocket Ping/Pong supplies liveness. Both sides must continuously read.
3. Each open has a random `request_id` and `tunnel_id`. Both are scoped to that
   connection. Open must complete within 15 seconds. Duplicate opens cannot
   spawn another child. Closed IDs remain tombstoned for the connection lifetime
   (up to 100,000 opens; subsequent opens return `quota_exceeded`).
4. After registration every control includes `connection_id`. All tunnel
   controls include the original request ID. `status` separately reports core
   availability; registration does not imply the core is healthy.
5. `error` codes include `incompatible_version`, `unsupported_capabilities`,
   `invalid_registration`, `identity_conflict`, `registration_rejected`,
   `quota_exceeded`, and `core_unavailable`. Registration/auth failures stop
   the agent with an actionable error; transient transport loss backs off.
6. `close_tunnel` cancels only its `hc connect` process. `tunnel_closed` follows
   already queued DATA on orderly EOF. It never means `terminal.kill`.

Binary WebSocket messages have exactly this envelope:

| Offset | Length | Value |
|---|---:|---|
| 0 | 1 | version = `0x01` |
| 1 | 1 | kind DATA = `0x01` |
| 2 | 16 | UUID bytes in textual/network order (no GUID mixed-endian conversion) |
| 18 | remainder | unmodified core byte stream; may be empty |

A WebSocket message may contain only part of a core frame, or several frames.
Core frames use **little endian**, unlike the UUID's raw byte sequence. See the
pinned `contracts/core` documents. `vectors.json` is consumed by Go and TS tests.

Browser sockets `/ws/v1/bridges/{bridge_id}` carry **raw core bytes only**, not
this envelope. Server-side routing assigns a fresh tunnel per authenticated
socket. A browser cannot supply a routing ID. Session expiry/logout, key
revocation/expiry, user disablement, agent loss and server shutdown close its
viewing connections. UUID guessing cannot select another account's tunnel.

Queues are bounded per tunnel (both bytes and message count). The shared writer
selects one message per tunnel in round-robin order, giving control messages
priority. A full tunnel queue closes only that tunnel; a physical WebSocket
that cannot write within 10 seconds closes the link. The bound covers queued
bytes; one message may additionally be in flight on a shared writer. Control
queues hold at most 128 messages. No data is replayed on reconnection.
