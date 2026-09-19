# Transfer protocol v1

This is the contract between the two peers. It is deliberately independent of
any UI framework so the web client and the later Flutter client implement the
same thing.

Current version: **1** (see `VERSION`).

Both peers exchange `protocolVersion` in the first control message. Mismatch is
a hard failure with a clear message — never a best-effort attempt to carry on.

---

## Three channels

| Channel | Transport | Carries |
|---|---|---|
| signaling | WebSocket to the Go service | SDP, ICE, presence |
| control | `RTCDataChannel` `"control"`, ordered + reliable | JSON control messages |
| data | `RTCDataChannel` `"data"`, ordered + reliable | binary file chunks, nothing else |

The signaling service relays messages between exactly two peers and never sees
file bytes. It validates only that a message is a JSON object with a non-empty
`type`, then forwards the original bytes untouched.

---

## Signaling messages

Peer-to-peer, relayed verbatim:

```jsonc
{ "type": "offer",  "sdp": "v=0\r\n..." }
{ "type": "answer", "sdp": "v=0\r\n..." }
{ "type": "ice",    "candidate": { /* RTCIceCandidateInit */ } }
```

Server-originated events, never forwarded on:

```jsonc
{ "type": "peer-joined",  "detail": "sender" | "receiver" }
{ "type": "peer-left",    "detail": "sender" | "receiver" }
{ "type": "peer-absent",  "detail": "" }   // you sent something; nobody is there
{ "type": "error",        "detail": "..." }
```

`peer-joined` is the sender's cue to create the offer. The sender is always the
WebRTC impolite peer (it makes the offer); the receiver answers.

---

## Control messages

```jsonc
{ "type": "HELLO", "protocolVersion": 1, "role": "sender" | "receiver" }

{ "type": "FILE_OFFER",
  "transferId": "...",
  "fileId": "...",
  "name": "ubuntu.iso",
  "size": "8402653184",        // decimal string — see below
  "mimeType": "application/x-iso9660-image",
  "lastModified": 1735689600000,
  "chunkSize": 65536 }

{ "type": "FILE_ACCEPT", "fileId": "..." }
{ "type": "FILE_REJECT", "fileId": "...", "reason": "declined" }

{ "type": "TRANSFER_START", "fileId": "..." }
{ "type": "PAUSE",  "fileId": "..." }
{ "type": "RESUME", "fileId": "...", "fromOffset": "1073741824" }

{ "type": "CHECKPOINT", "fileId": "...", "receivedBytes": "1073741824" }

{ "type": "TRANSFER_COMPLETE", "fileId": "...", "sha256": "..." }
{ "type": "TRANSFER_FAILED",   "fileId": "...", "code": "...", "message": "..." }
```

`FILE_OFFER` carries only what the receiver needs to decide and to allocate.
No paths, no EXIF, no thumbnails, no anything else from the sender's disk.

---

## Byte counts are decimal strings

**Every byte offset and file size on the wire is a JSON string, not a number.**

JSON numbers land in a JavaScript `number`, which is an IEEE-754 double and
loses integer precision above 2^53 − 1 (9,007,199,254,740,991 — about 9 PB).
A 100 GB file is nowhere near that, so the ceiling is not the real reason.

The real reason is that Go and Dart both have a genuine `int64` and JavaScript
does not, so a number crossing the three languages gets silently coerced
through `float64` on one leg of the trip. Strings make the boundary explicit:
every implementation parses to its own 64-bit type and nothing is rounded on
the way. It also means the wire format does not change if a future version
raises the limit.

- JavaScript/TypeScript: parse with `BigInt(s)`, serialise with `String(n)`
- Go: `strconv.ParseInt(s, 10, 64)` / `strconv.FormatInt(n, 10)`
- Dart: `int.parse(s)` / `n.toString()`

Small bounded numbers — `protocolVersion`, `chunkSize`, `lastModified` — stay
plain JSON numbers. They cannot approach the precision limit.

---

## Chunking and ordering

The data channel is **ordered and reliable**, so SCTP already guarantees the
receiver sees chunks in the order they were sent. Chunks therefore carry no
header: the data channel transmits raw file bytes and the receiver appends them
in arrival order. Position is tracked by counting bytes, not by reading an
offset off each chunk.

This is why control lives on its own channel — a JSON message and a chunk must
never share a stream where one could be mistaken for the other.

Default chunk size is **64 KiB**, configurable. At connect time, clamp it to
the negotiated `RTCSctpTransport.maxMessageSize`, which varies by browser and
by remote implementation. Never assume 64 KiB is safe; read what was actually
negotiated.

The sender reads the file with `File.slice()` — never `file.arrayBuffer()` on
the whole file, which would pull 100 GB into memory and defeat the entire
architecture.

## Backpressure

Mandatory, and the reason memory stays flat regardless of file size:

```
while bytes remain:
    if dataChannel.bufferedAmount <= bufferedAmountLowThreshold:
        send(next chunk)
    else:
        await 'bufferedamountlow'
```

Calling `send()` in a tight loop buffers the whole file in the browser's SCTP
queue and crashes the tab. A 100 GB transfer must not cost materially more RAM
than a 100 MB one.

---

## Integrity

The sender hashes as it reads, in a Web Worker, and sends SHA-256 in
`TRANSFER_COMPLETE`. The receiver hashes as it writes and compares. A mismatch
fails the transfer loudly — a corrupt 100 GB file that claims success is worse
than an honest failure.

---

## Limits

```
maxTransferBytes = 100_000_000_000   # 100 GB, decimal, not GiB
```

Decimal GB because that is the number shown in the UI, and the displayed limit
and the enforced limit must be the same number. Defined once per language:

- Go: `MaxTransferBytes` in `services/signaling/main.go`
- TypeScript: `MAX_TRANSFER_BYTES` in `apps/web`

If multiple files per transfer are added later, the limit applies to the total
payload, not per file.

---

## Session lifetime

| State | TTL | Env var |
|---|---|---|
| created, nobody connected | 10 min | `SESSION_IDLE_TTL` |
| peers connected | 30 min, refreshed on traffic | `SESSION_ACTIVE_TTL` |
| both peers gone | falls back to idle TTL, then reaped | `SESSION_REAP_EVERY` |

An active transfer refreshes its session on every relayed message, so a long
transfer cannot expire underneath itself.

---

## Capabilities

A session mints two independent 256-bit tokens. The server stores only their
SHA-256 digests, compares in constant time, and never logs either one.

```
https://example.com/t/<sessionId>#token=<receiverToken>
```

The receiver token lives in the URL **fragment**, which browsers do not send in
the HTTP request — so the capability never reaches the server's access logs,
any proxy in between, or a `Referer` header. Client-side JavaScript reads it and
presents it when opening the WebSocket.

The two tokens are role-scoped: the sender's token cannot open the receiver slot
and vice versa. Both are rejected before the WebSocket upgrade, so an
unauthorized caller gets an HTTP 401 and never costs a socket.
