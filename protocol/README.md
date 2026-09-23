# Transfer protocol v2

This is the contract between the two peers. It is deliberately independent of
any UI framework so the web client and the later Flutter client implement the
same thing.

Current version: **2** (see `VERSION`).

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
{ "type": "HELLO", "protocolVersion": 2, "role": "sender" | "receiver" }

// One offer describes the whole batch. A single file is a batch of one;
// there is no second code path for it.
{ "type": "MANIFEST",
  "transferId": "...",
  "chunkSize": 65536,
  "totalBytes": "8402653184",     // decimal string — see below
  "note": "the raws from saturday",   // optional, free text, may be absent
  "files": [
    { "fileId": "...",
      "name": "ubuntu.iso",       // last path segment only, never a path
      "path": "isos/2024",        // relative directory inside the batch, "" if none
      "size": "8402653184",
      "mimeType": "application/x-iso9660-image",
      "lastModified": 1735689600000 }
  ] }

{ "type": "MANIFEST_ACCEPT", "transferId": "..." }
{ "type": "MANIFEST_REJECT", "transferId": "...", "reason": "declined" }

{ "type": "TRANSFER_START", "transferId": "..." }

{ "type": "PAUSE",  "transferId": "..." }
{ "type": "RESUME", "transferId": "...", "fromOffset": "1073741824" }

// Sent after the last byte of each file, and acknowledged per file.
{ "type": "FILE_DONE",     "fileId": "...", "sha256": "..." }
{ "type": "FILE_VERIFIED", "fileId": "..." }

{ "type": "TRANSFER_COMPLETE", "transferId": "..." }   // sender: that was the last byte
{ "type": "TRANSFER_VERIFIED", "transferId": "..." }   // receiver: all files written and checked
{ "type": "TRANSFER_FAILED",   "transferId": "...", "code": "...", "message": "..." }
```

`MANIFEST` carries only what the receiver needs to decide and to allocate. No
absolute paths, no EXIF, no thumbnails, no anything else from the sender's disk.
`path` exists solely so a sent folder can be recreated rather than flattened;
it is relative, and every segment is sanitized on arrival.

### What changed from v1

v1 exchanged one `FILE_OFFER` per file and accepted it one at a time. v2
replaces that with the manifest above, because the round trip per file made a
folder of small files far slower than the same bytes in one file, and because
the receiver could not ask for a destination once for the whole batch.

`FILE_OFFER`, `FILE_ACCEPT`, `FILE_REJECT` and the per-file
`TRANSFER_COMPLETE` are gone. The version is checked in `HELLO` and a mismatch
is a hard failure, so a v1 client meeting a v2 client is told to reload rather
than half-working.

---

## Batching and file boundaries

Files stream **back to back on the data channel with nothing between them** —
no per-file header, no separator, no round trip. The manifest already gives
every size, so the receiver knows where each file ends by counting bytes:

```
position in batch  ->  (file index, offset in that file)
```

A chunk may therefore straddle a boundary, and several small files may land
inside one chunk. The receiver splits accordingly, closing one file and opening
the next mid-chunk. That arithmetic is the part that corrupts a transfer
silently if it is wrong — an off-by-one puts the tail of one file at the head of
the next and both fail their checksums — so it is isolated and tested on its own
(`apps/web/src/lib/transfer/cursor.ts`).

`FILE_DONE` rides the control channel, which is a **separate SCTP stream** from
the data channel and can therefore overtake the tail of its own file. The
receiver parks the digest until its own byte count says that file is whole, and
only then compares. The same hazard is why `TRANSFER_COMPLETE` is sent only
after the data channel's send buffer has fully drained.

Bytes arriving past the end of the last declared file are an overflow, not data:
the receiver aborts rather than writing them.

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

Per file, not per transfer. The sender hashes each file as it reads, in a Web
Worker, and sends SHA-256 in that file's `FILE_DONE`. The receiver hashes as it
writes and compares when the file completes, answering `FILE_VERIFIED`. A
mismatch fails the whole transfer loudly and names the file — a corrupt 100 GB
file that claims success is worse than an honest failure.

A file that fails verification is truncated to zero rather than left as a
plausible-looking partial, and deleted outright where the receiver holds a
directory handle. Files verified earlier in the same batch are already closed
and are left intact.

---

## Limits

```
maxTransferBytes = 100_000_000_000   # 100 GB, decimal, not GiB
```

Decimal GB because that is the number shown in the UI, and the displayed limit
and the enforced limit must be the same number. Defined once per language:

- Go: `MaxTransferBytes` in `services/signaling/main.go`
- TypeScript: `MAX_TRANSFER_BYTES` in `apps/web`
- Dart: `maxTransferBytes` in `apps/mobile/packages/direct_protocol`

The limit applies to the **total payload of a transfer**, not to each file. A
receiver recomputes the total from the manifest's own entries and rejects a
manifest whose declared total disagrees with them, so understating it buys
nothing.

A transfer also carries at most **500 files** (`MAX_FILES_PER_TRANSFER`), which
bounds the manifest itself rather than the bytes.

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
