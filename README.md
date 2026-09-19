# File_Shareing

Peer-to-peer file transfer for large files. The sender picks a file, gets a share
link, and the receiver opens it. The bytes go straight from one browser to the
other over WebRTC — the server only helps the two peers find each other.

Target: transfers up to 100 GB, with both peers online during the transfer.

## Why not just upload it somewhere

Because then the file sits on someone else's disk. Here it never leaves the
sender's device except to go to the receiver. No S3, no R2, no bucket, no
database row holding file bytes. The signaling service handles session IDs, SDP
offers and answers, ICE candidates and connection state. Nothing else.

## How it works

```
Sender                    Signaling (WebSocket)                  Receiver
  |-- create session ----------->|                                   |
  |<-- share URL ----------------|                                   |
  |                              |<---------- open share URL --------|
  |<--------- SDP / ICE exchange over signaling ------------------->|
  |======== WebRTC DataChannel, file streams directly =============>|
```

Two logical channels: a control channel for the handshake and transfer state
(`FILE_OFFER`, `FILE_ACCEPT`, `TRANSFER_START`, `PAUSE`, `CHECKPOINT`,
`TRANSFER_COMPLETE`), and a data channel for the chunks. Chunking plus
backpressure handling is what keeps a 100 GB transfer from blowing up the tab.

NAT traversal uses STUN, with TURN as a fallback when a direct path can't be
established.

## Stack

**Web** — Next.js, React, TypeScript (strict), Tailwind, WebRTC, Web Workers for
hashing and chunk handling, IndexedDB where the receiver needs to persist.

**Signaling** — Go, WebSockets, small dependency footprint, Docker. File data
never passes through it.

**Storage** — none required. Sessions live in memory and expire on a TTL. The
session store sits behind an interface so Redis can slot in when there's more
than one signaling instance. No Postgres until something actually needs it.

**Mobile** — Flutter, later, on the same protocol and the same signaling
backend. Not started.

## Layout

```
apps/web/              web client
services/signaling/    Go signaling service
protocol/              wire schemas, fixtures, version
docs/                  architecture, protocol, security, deployment notes
```

## Status

Early. Web client first — mobile work doesn't start until the web app can
actually move a large file end to end and the docs are written.

## Running it

Not wired up yet. Once the signaling service and web app land, this section gets
the real commands.
