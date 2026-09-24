import { Backlog } from "./backlog";
import { BatchCursor } from "./cursor";
import { createPeerConnection, sendControl, unreachableMessage } from "./connection";
import { StreamHasher } from "./hasher";
import {
  PROTOCOL_VERSION,
  isControlMessage,
  manifestFromMessage,
  type ControlMessage,
  type Manifest,
  type ManifestEntry,
  type SignalMessage,
} from "./protocol";
import { ProgressMeter, type Progress } from "./progress";
import {
  assessCapability,
  openDestination,
  type Capability,
  type Destination,
  type WriteSink,
} from "./sink";
import { SignalingChannel } from "./signaling";

export type ReceiverState =
  | "connecting"
  | "waiting"       // connected, sender has not offered yet
  | "offered"       // waiting on the user to accept
  | "receiving"
  | "verifying"
  | "complete"
  | "declined"
  | "senderGone"
  | "expired"
  | "failed";

export type IncomingFileState = "queued" | "receiving" | "verified" | "failed";

export interface IncomingFile {
  entry: ManifestEntry;
  state: IncomingFileState;
  transferred: bigint;
}

export interface ReceiverSnapshot {
  state: ReceiverState;
  manifest: Manifest | null;
  files: IncomingFile[];
  current: number;
  capability: Capability | null;
  progress: Progress;
  error: string | null;
  verified: boolean;
  /** Where the files were written, once a destination is chosen. */
  savedTo: string | null;
}

export class FileReceiver {
  private signaling: SignalingChannel | null = null;
  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private destination: Destination | null = null;
  private sink: WriteSink | null = null;
  private hasher: StreamHasher | null = null;
  private meter = new ProgressMeter();

  private state: ReceiverState = "connecting";
  private manifest: Manifest | null = null;
  private statuses: IncomingFile[] = [];
  private capability: Capability | null = null;
  private error: string | null = null;
  private verified = false;
  private savedTo: string | null = null;

  /**
   * Set the moment the batch is failed. `state` cannot stand in for this:
   * fail() can land while finish() is awaiting the write queue, and a flag
   * read after that await is the only thing that catches it.
   */
  private aborted = false;

  /** Decides which file each wire byte belongs to; see cursor.ts. */
  private cursor = new BatchCursor([]);
  private index = 0;
  private received = 0n;

  /**
   * Digests announced by the sender, keyed by fileId.
   *
   * FILE_DONE travels on the control channel and can overtake the tail of its
   * own file on the data channel, so it is parked here until our own byte
   * count says that file is whole.
   */
  private digests = new Map<string, string>();
  private digestWaiters = new Map<string, () => void>();

  /** True once the data channel is open and signaling stops mattering. */
  private linked = false;

  private addCandidate: ((c: RTCIceCandidateInit) => void) | null = null;
  private remoteReady: (() => Promise<void>) | null = null;

  /**
   * Candidates that arrived before the peer connection existed. The sender
   * starts trickling the moment it sends its offer, and we only build our
   * connection once that offer is parsed — so without this queue the first
   * candidates, usually the host ones that make a local connection work, are
   * dropped and the connection can fail to form.
   */
  private earlyCandidates: RTCIceCandidateInit[] = [];

  private queueCandidate(c: RTCIceCandidateInit): void {
    if (this.addCandidate) this.addCandidate(c);
    else this.earlyCandidates.push(c);
  }

  constructor(
    private readonly sessionId: string,
    private readonly token: string,
    private readonly onChange: (s: ReceiverSnapshot) => void,
  ) {}

  private emit(state?: ReceiverState): void {
    if (state) this.state = state;
    this.onChange({
      state: this.state,
      manifest: this.manifest,
      files: this.statuses,
      current: this.state === "receiving" ? this.index : -1,
      capability: this.capability,
      progress: this.meter.snapshot(),
      error: this.error,
      verified: this.verified,
      savedTo: this.savedTo,
    });
  }

  private fail(message: string, state: ReceiverState = "failed"): void {
    // A finished transfer is immune: the sender tears the connection down
    // once it has our TRANSFER_VERIFIED, and that must not turn a success
    // into a connection error on this side either.
    if (this.aborted || this.state === "complete" || this.state === "declined") return;
    this.aborted = true;
    this.error = message;
    if (this.statuses[this.index]) this.statuses[this.index]!.state = "failed";
    void this.sink?.abort();
    this.sink = null;
    void this.destination?.finish(false);
    this.emit(state);
    this.cleanup();
  }

  async start(): Promise<void> {
    this.emit("connecting");
    this.signaling = new SignalingChannel(this.sessionId, "receiver", this.token);

    try {
      await this.signaling.connect({
        onMessage: (msg) => void this.onSignal(msg),
        onClose: () => {
          if (this.state === "connecting" || this.state === "waiting") {
            this.fail("This transfer link has expired, or the sender closed their tab.", "expired");
          }
        },
      });
    } catch {
      this.fail("This transfer link is invalid or has expired.", "expired");
      return;
    }

    this.emit("waiting");
  }

  private async onSignal(msg: SignalMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "offer":
          await this.answer(msg.sdp);
          break;
        case "ice":
          this.queueCandidate(msg.candidate);
          break;
        case "peer-left":
          // See the note in sender.ts: after the peer connection is up, the
          // signaling socket goes idle and its closing means nothing. The
          // data channel reports real loss.
          if (!this.linked && this.state !== "complete") {
            this.fail("The sender is no longer online.", "senderGone");
          }
          break;
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "Connection negotiation failed.");
    }
  }

  private async answer(sdp: string): Promise<void> {
    if (this.pc) return;

    const { pc, addRemoteCandidate, onRemoteDescriptionSet } = await createPeerConnection(this.signaling!);
    this.pc = pc;
    this.addCandidate = addRemoteCandidate;
    this.remoteReady = onRemoteDescriptionSet;

    // Replay anything that arrived while we were still parsing the offer.
    for (const c of this.earlyCandidates.splice(0)) addRemoteCandidate(c);

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.fail(unreachableMessage());
    };

    // The sender creates both channels; we attach as they arrive.
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === "control") {
        this.control = ev.channel;
        this.control.onmessage = (m) => void this.onControl(m);
      } else if (ev.channel.label === "data") {
        ev.channel.binaryType = "arraybuffer";
        ev.channel.onmessage = (m) => this.onChunk(m);
        ev.channel.onopen = () => {
          this.linked = true;
          this.signaling?.retireReconnect();
        };
        ev.channel.onclose = () => {
          // Real peer loss, as opposed to a dropped signaling socket.
          if (this.state === "receiving") {
            this.fail("The sender disconnected before the transfer finished.", "senderGone");
          }
        };
        if (ev.channel.readyState === "open") {
          this.linked = true;
          this.signaling?.retireReconnect();
        }
      }
    };

    await pc.setRemoteDescription({ type: "offer", sdp });
    await this.remoteReady();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.signaling!.send({ type: "answer", sdp: answer.sdp! });
  }

  private async onControl(ev: MessageEvent): Promise<void> {
    let msg: ControlMessage;
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    if (!isControlMessage(msg)) return;

    switch (msg.type) {
      case "HELLO":
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.fail(
            `The sender speaks protocol v${msg.protocolVersion}, this page speaks v${PROTOCOL_VERSION}. One of you needs to reload.`,
          );
        }
        break;

      case "MANIFEST":
        try {
          this.manifest = manifestFromMessage(msg);
        } catch (err) {
          // A malformed manifest means the far side is broken or hostile.
          this.fail(err instanceof Error ? err.message : "The sender sent an invalid file list.");
          return;
        }
        this.statuses = this.manifest.files.map((entry) => ({
          entry,
          state: "queued",
          transferred: 0n,
        }));
        this.capability = assessCapability(this.manifest.totalBytes, this.manifest.files.length);
        this.emit("offered");
        break;

      case "FILE_DONE":
        this.digests.set(msg.fileId, msg.sha256);
        this.digestWaiters.get(msg.fileId)?.();
        this.digestWaiters.delete(msg.fileId);
        break;

      case "TRANSFER_COMPLETE":
        await this.finish();
        break;

      case "TRANSFER_FAILED":
        this.fail(msg.message || "The sender reported a failure.");
        break;
    }
  }

  /**
   * Accept and start receiving.
   *
   * Must be called directly from a click: the save and folder dialogs only
   * open inside a user gesture, and nothing may be awaited before them.
   */
  async accept(): Promise<void> {
    const manifest = this.manifest;
    if (!manifest || !this.control) return;

    try {
      this.destination = await openDestination(manifest.files, manifest.totalBytes);
    } catch (err) {
      // A cancelled dialog is a decision, not a failure.
      if (err instanceof DOMException && err.name === "AbortError") return;
      this.fail(err instanceof Error ? err.message : "Could not open a place to save the files.");
      return;
    }

    this.savedTo = this.destination.label;
    this.received = 0n;
    this.index = 0;
    this.cursor = new BatchCursor(manifest.files.map((f) => f.size));

    try {
      await this.openCurrent();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "Could not open a place to save the files.");
      return;
    }

    this.meter.start(manifest.totalBytes);
    this.emit("receiving");

    sendControl(this.control, { type: "MANIFEST_ACCEPT", transferId: manifest.transferId });
  }

  decline(): void {
    if (this.control && this.manifest) {
      sendControl(this.control, {
        type: "MANIFEST_REJECT",
        transferId: this.manifest.transferId,
        reason: "declined",
      });
    }
    this.emit("declined");
    this.cleanup();
  }

  /**
   * Chunks arrive in order, but handling one is asynchronous — it writes to
   * disk and feeds the hash. Letting two handlers overlap would let the
   * second reach the hasher first and fail verification on a transfer that
   * was actually perfect, so every chunk goes through one queue.
   */
  private writes: Promise<void> = Promise.resolve();

  /** Bytes taken off the wire but not yet on disk; see backlog.ts. */
  private backlog = new Backlog(8 * 1024 * 1024, 2 * 1024 * 1024);

  private onChunk(ev: MessageEvent): void {
    const chunk = ev.data as ArrayBuffer;

    // Measure now: hashing transfers this buffer to the worker, which
    // detaches it, and a detached buffer reports a length of zero.
    const size = chunk.byteLength;

    if (this.backlog.arrived(size) && this.control && this.manifest) {
      sendControl(this.control, { type: "PAUSE", transferId: this.manifest.transferId });
    }

    this.writes = this.writes.then(async () => {
      await this.consume(chunk);
      if (this.backlog.written(size) && this.control && this.manifest) {
        sendControl(this.control, {
          type: "RESUME",
          transferId: this.manifest.transferId,
          fromOffset: this.received.toString(),
        });
      }
    });
  }

  /**
   * Route one wire chunk into one or more files.
   *
   * Files stream back to back with nothing between them, so a chunk can
   * straddle a boundary. The manifest gives every size up front, which is
   * what makes plain byte counting enough to know where each file ends — no
   * per-chunk header, no round trip between files.
   */
  private async consume(chunk: ArrayBuffer): Promise<void> {
    // Not a state check: finish() flips the state to "verifying" and only then
    // awaits this queue, so anything still queued behind it would be dropped
    // on the floor and the batch would report itself short. The tail of a
    // transfer legitimately lands while the UI already says "verifying".
    if (this.aborted || !this.destination) return;

    const { pieces, overflow } = this.cursor.split(chunk.byteLength);

    if (overflow > 0) {
      // The sender is a stranger. Refuse more bytes than it said it would
      // send rather than letting it write unbounded data to the user's disk.
      this.fail("The sender sent more data than it declared. Transfer aborted.");
      return;
    }

    for (const piece of pieces) {
      const entry = this.manifest?.files[piece.index];
      // `index` is which file the open sink belongs to; the cursor has already
      // advanced past every piece in this chunk. If those ever disagree, the
      // next bytes would be written into the wrong file and still pass that
      // file's checksum, so this is checked rather than assumed.
      if (!entry || !this.sink || !this.hasher || piece.index !== this.index) {
        this.fail("The transfer arrived out of step with its file list. Transfer aborted.");
        return;
      }

      // Whole chunk for one file is the common case: pass the buffer straight
      // through so nothing is copied. A boundary-straddling chunk is sliced,
      // which is a copy — but that happens once per file, not once per chunk.
      const whole = piece.offset === 0 && piece.length === chunk.byteLength;
      const bytes = whole ? chunk : chunk.slice(piece.offset, piece.offset + piece.length);

      try {
        await this.sink.write(bytes);
        // write() has consumed the bytes, so the buffer can be transferred to
        // the hashing worker, which detaches it.
        await this.hasher.update(bytes);
      } catch (err) {
        this.fail(err instanceof Error ? err.message : "Could not write the file to disk.");
        return;
      }

      this.received += BigInt(piece.length);
      this.statuses[piece.index]!.transferred += BigInt(piece.length);
      this.meter.set(this.received);

      if (piece.endsFile) {
        const ok = await this.closeCurrent(piece.index, entry);
        if (!ok) return;
      }
      this.emit();
    }
  }

  /** Open the sink and hasher for the file at `index`. */
  private async openCurrent(): Promise<void> {
    const entry = this.manifest?.files[this.index];
    if (!entry || !this.destination) return;

    this.sink = await this.destination.open(entry);
    this.hasher = new StreamHasher();
    await this.hasher.init();
    this.statuses[this.index]!.state = "receiving";
  }

  /**
   * Finish the current file: check its digest, close it, move to the next.
   *
   * Returns false when the batch has been failed, so the caller stops.
   */
  private async closeCurrent(index: number, entry: ManifestEntry): Promise<boolean> {
    const hasher = this.hasher;
    const sink = this.sink;
    if (!hasher || !sink) return false;

    const actual = await hasher.final();
    hasher.destroy();
    this.hasher = null;

    // The digest rides the control channel, which can lag the data channel's
    // tail by a few milliseconds. Wait for it rather than guessing.
    const expected = await this.digestFor(entry.fileId);

    if (!expected || actual !== expected) {
      await sink.abort();
      this.sink = null;
      this.fail(
        `“${entry.name}” failed verification — the received bytes did not match the sender's checksum, ` +
          `so the file was discarded. What is left where you chose to save it is empty, not a partial copy.`,
      );
      return false;
    }

    try {
      await sink.close();
    } catch (err) {
      this.sink = null;
      this.fail(err instanceof Error ? err.message : "Could not finish writing the file.");
      return false;
    }

    this.sink = null;
    this.statuses[index]!.state = "verified";
    if (this.control) {
      sendControl(this.control, { type: "FILE_VERIFIED", fileId: entry.fileId });
    }

    // The next file, not wherever the cursor has got to: the cursor is already
    // past every piece in this chunk, and several small files can finish
    // inside one of them.
    this.index = index + 1;

    if (this.index < (this.manifest?.files.length ?? 0)) {
      try {
        await this.openCurrent();
      } catch (err) {
        this.fail(err instanceof Error ? err.message : "Could not open the next file for writing.");
        return false;
      }
    }
    return true;
  }

  /** Resolve once the sender has announced this file's digest. */
  private digestFor(fileId: string): Promise<string | undefined> {
    const known = this.digests.get(fileId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      this.digestWaiters.set(fileId, () => resolve(this.digests.get(fileId)));
    });
  }

  /**
   * Wait for the declared bytes to finish arriving.
   *
   * Bounded by silence rather than by a total time: how long the rest of a
   * file takes is a property of the link and unknowable here, while "nothing
   * has arrived for ten seconds" means the same on every link — there is no
   * tail still coming, and the transfer really is short.
   */
  private async awaitTail(totalBytes: bigint): Promise<void> {
    const step = 100;
    const patience = 100; // ten seconds of silence

    let seen = this.received;
    let idle = 0;
    while (!this.aborted && this.received < totalBytes && idle < patience) {
      await new Promise((r) => setTimeout(r, step));
      if (this.received !== seen) {
        seen = this.received;
        idle = 0;
      } else {
        idle++;
      }
    }
  }

  private async finish(): Promise<void> {
    if (this.aborted || this.verified) return;
    this.emit("verifying");

    const manifest = this.manifest;
    if (!manifest) return;

    // The tail of the transfer may still be on the wire. TRANSFER_COMPLETE
    // rides the control channel, and SCTP orders each stream independently, so
    // a small control message overtakes megabytes already queued on the data
    // channel whenever the link is slow enough to have a queue — a relayed
    // transfer to a phone, say. With both peers local, as in the e2e suite,
    // there is never a queue and this never shows.
    await this.awaitTail(manifest.totalBytes);

    // And the last chunks may still be queued behind the disk.
    await this.writes.catch(() => undefined);

    if (this.aborted) return;

    // A short transfer that claims completion is a failure, not a success.
    if (this.received !== manifest.totalBytes) {
      sendControl(this.control!, {
        type: "TRANSFER_FAILED",
        transferId: manifest.transferId,
        code: "short_read",
        message: "Receiver got fewer bytes than declared.",
      });
      this.fail(
        "The transfer ended early, so the last file is incomplete and was discarded. " +
          "Files that had already been verified are intact where you chose to save them.",
      );
      return;
    }

    await this.destination?.finish(true);
    this.verified = true;

    // Tell the sender before tearing anything down, so it can stop showing
    // "sending" while we were finishing the write.
    if (this.control) {
      sendControl(this.control, { type: "TRANSFER_VERIFIED", transferId: manifest.transferId });
    }

    this.emit("complete");
    this.cleanup();
  }

  cancel(): void {
    void this.sink?.abort();
    this.sink = null;
    this.cleanup();
  }

  private cleanup(): void {
    this.hasher?.destroy();
    this.hasher = null;
    this.control?.close();
    this.pc?.close();
    this.signaling?.close();
    this.pc = null;
    this.signaling = null;
  }
}
