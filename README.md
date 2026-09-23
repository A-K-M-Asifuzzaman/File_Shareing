# Direct

Peer-to-peer file transfer for large files. The sender picks files — or a whole
folder — gets one share link, and the receiver opens it. The bytes go straight
from one device to the other over WebRTC; the server only helps the two peers
find each other.

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
(`MANIFEST`, `MANIFEST_ACCEPT`, `TRANSFER_START`, `PAUSE`, `FILE_DONE`,
`TRANSFER_COMPLETE`), and a data channel for the chunks. Chunking plus
backpressure handling is what keeps a 100 GB transfer from blowing up the tab.

One transfer carries a **batch**: any number of files up to 500, with folder
structure preserved. The manifest announces the whole set up front, and the
files then stream back to back with no round trip between them — which is why a
folder of two hundred small files is not slower than the same bytes in one
file. Each file still gets its own SHA-256, so a failure names the file it
happened to.

NAT traversal uses STUN, with TURN as a fallback when a direct path can't be
established.

## Stack

**Web** — Next.js, React, TypeScript (strict), Tailwind, WebRTC, Web Workers for
hashing, the File System Access API for streaming to disk. A QR code for the
share link, a local transfer history, and a diagnostics page that tests the
network path without starting a transfer.

**Theme** — two independent axes, mirrored between the web and Flutter clients
so both look like the same product:

| Axis | Values | Carried on |
|---|---|---|
| scheme | light, dark, or the OS preference | `<html data-theme>` |
| accent | signal, ion, ember, violet, bone | `<html data-accent>` |

The accent is the single colour the interface spends — progress, verification,
focus, selection, the WebGL field — so choosing it changes nothing structural.
Each accent declares its light and dark values once and the scheme picks
between them, so adding one is six lines rather than another copy of the
palette. Tokens are hex on purpose: the backdrop shader reads them back out of
computed style, and a colour space it could not parse would silently fall back
to a hardcoded lime.

Both choices are applied by an inline script before first paint, because a
frame of the wrong scheme on this palette is a white flash on a black page.

**Signaling** — Go, WebSockets, small dependency footprint, Docker. File data
never passes through it.

**Storage** — none required. Sessions live in memory and expire on a TTL. The
session store sits behind an interface so Redis can slot in when there's more
than one signaling instance. No Postgres until something actually needs it.

**Mobile** — Flutter, on the same protocol and the same signaling backend. A
foreground service keeps a transfer running while the app is backgrounded,
which is the one thing the web client cannot do. The wire contract lives in
`packages/direct_protocol`, a pure Dart package with no Flutter dependency, so
it is testable without a device and stays honest against the web client.

## Layout

```
apps/web/              Next.js client — UI and the transfer engine
  src/lib/transfer/    framework-free protocol, chunking, hashing, sinks
  src/lib/ui/          theme, local history, notifications, drop handling
apps/mobile/           Flutter client
  packages/direct_protocol/   the wire contract as pure Dart
  lib/transfer/        the same engine against flutter_webrtc
services/signaling/    Go signaling service
protocol/              wire protocol v2, the contract both clients implement
```

## Running it

Two processes. The signaling service:

```
cd services/signaling
go run .                      # :8080, override with SIGNALING_ADDR
```

The web client:

```
cd apps/web
cp ../../.env.example .env.local   # point NEXT_PUBLIC_SIGNALING_URL at the service
npm install
npm run dev                        # :3000
```

Open two browsers, send a file from one, paste the link into the other.

The mobile client:

```
cd apps/mobile
flutter pub get
flutter run                        # a device or emulator; point it at the service
```

## Tests

```
cd services/signaling && go test -race ./...           # store, auth, TTL, relay
cd services/signaling && node smoke.mjs                # HTTP surface, needs the service running
cd apps/web && npm test && npm run lint && npm run typecheck
cd apps/mobile/packages/direct_protocol && dart test   # the wire contract, both ends
cd apps/mobile && flutter analyze
```

`smoke.mjs` needs the service running; set `PORT` if it is not on 8080.

### A real transfer, browser to browser

```
cd apps/web && npm run e2e
```

Drives two Chromium pages through an actual transfer — one file through the
save picker, then a four-file batch through the folder picker — and checks the
SHA-256 of every byte that arrived. The save dialog is native and cannot be
driven, so the File System Access API is stubbed in the receiver page; nothing
else is faked.

It needs the signaling service and `npm run start` up, and a Chromium at
`$CHROME`. `E2E_TRACE=1` prints ICE candidates and connection states from both
pages, which is the first thing to reach for when it will not connect.

This is the test that matters most. It has so far caught three bugs that every
unit suite passed straight through:

- the receiver dropping the tail of every transfer, because `finish()` flipped
  the state before draining its own write queue;
- a completed transfer overwriting "Sent and verified" with "could not open a
  direct connection", because the peer tearing down after success still ran
  the failure path;
- the receiver building its peer connection before the ICE configuration
  arrived, so it negotiated against the STUN-only fallback — no relay for the
  peer most likely to need one.

None of those are visible from a unit test, and all three would have shipped.

The Dart and TypeScript suites deliberately assert the *same* things about the
protocol — manifest validation, filename and path sanitising, and the batch
routing arithmetic. If the two drift, transfers between a phone and a browser
fail in ways that are painful to debug at the WebRTC layer, so the contract is
pinned on both sides rather than trusted.

## Status

Signaling service, web client and Flutter client are all in, all speaking
protocol v2. The transfer engine is complete on both: chunked reads,
backpressure in both directions, streaming to disk, per-file SHA-256, batches
and folders.

Not done yet: resuming a transfer across a *dropped connection* — pausing works
and holds the connection open, but a genuinely lost peer still means starting
over. That needs the receiver to persist its offset and the sender to seek,
which is a real piece of work and not worth starting before the current version
has been run against more real networks.
