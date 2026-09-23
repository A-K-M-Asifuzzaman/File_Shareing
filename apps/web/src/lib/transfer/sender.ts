import {
  createChannels,
  createPeerConnection,
  negotiatedChunkSize,
  sendControl,
  unreachableMessage,
  waitForOpen,
} from "./connection";
import { StreamHasher } from "./hasher";
import {
  MAX_FILES_PER_TRANSFER,
  MAX_TRANSFER_BYTES,
  PROTOCOL_VERSION,
  formatBytes,
  isControlMessage,
  manifestToMessage,
  sanitizeFilename,
  sanitizeNote,
  sanitizePath,
  type ControlMessage,
  type Manifest,
  type ManifestEntry,
  type SignalMessage,
} from "./protocol";
import { SignalingChannel, createSession, buildShareUrl, type SessionCredentials } from "./signaling";
import { ProgressMeter, type Progress } from "./progress";

export type SenderState =
  | "idle"
  | "creating"
  | "waiting"        // link created, nobody has opened it
  | "connecting"     // receiver arrived, negotiating
  | "offering"       // waiting for accept or decline
  | "transferring"
  | "verifying"
  | "complete"
  | "declined"
  | "failed";

export type FileState = "queued" | "sending" | "sent" | "verified" | "failed";

export interface FileStatus {
  entry: ManifestEntry;
  state: FileState;
  transferred: bigint;
}

export interface SenderSnapshot {
  state: SenderState;
  shareUrl: string | null;
  /** Overall progress across the whole batch. */
  progress: Progress;
  files: FileStatus[];
  /** Index into `files` currently on the wire, or -1. */
  current: number;
  totalBytes: bigint;
  note: string;
  error: string | null;
  /** True while the user has paused the transfer by hand. */
  paused: boolean;
}

/**
 * Buffer threshold for backpressure. Sending until the buffer is full is what
 * turns a 100 GB transfer into a crashed tab; we top the queue up to 1 MB and
 * then wait for it to drain.
 */
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;

/**
 * A file plus where it sits in the batch.
 *
 * The relative path cannot be derived from a File: `webkitRelativePath` is set
 * when a directory was chosen through an input, and is empty for a file that
 * came from a drop or the clipboard, where the path has to be walked out of
 * the DataTransfer entries instead. Carrying it alongside keeps both sources
 * honest rather than having half the app quietly lose folder structure.
 */
export interface PickedFile {
  file: File;
  /** Relative directory inside the batch, "" for a file on its own. */
  path: string;
}

/** Wrap files from an <input>, keeping any folder structure the browser gave. */
export function pickedFromInput(files: ArrayLike<File>): PickedFile[] {
  return Array.from(files).map((file) => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    return {
      file,
      path: relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "",
    };
  });
}

/**
 * Turn picked files into manifest entries.
 *
 * Everything is sanitized here rather than only at the far end, so a hostile
 * *local* name never reaches the wire in the first place.
 */
export function describeFiles(picked: PickedFile[]): ManifestEntry[] {
  return picked.map(({ file, path }) => ({
    fileId: crypto.randomUUID(),
    name: sanitizeFilename(file.name),
    path: sanitizePath(path),
    size: BigInt(file.size),
    mimeType: file.type || "application/octet-stream",
    lastModified: file.lastModified,
  }));
}

export class FileSender {
  private signaling: SignalingChannel | null = null;
  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private data: RTCDataChannel | null = null;
  private hasher: StreamHasher | null = null;
  private meter = new ProgressMeter();

  private state: SenderState = "idle";
  private shareUrl: string | null = null;
  private error: string | null = null;
  private cancelled = false;

  private manifest: Manifest | null = null;
  private statuses: FileStatus[] = [];
  private current = -1;
  private sentTotal = 0n;

  /** True once both data channels are open and signaling stops mattering. */
  private linked = false;

  /** Set while the receiver's write backlog is too deep for more data. */
  private remotePaused = false;
  /** Set while the user has paused by hand. */
  private userPaused = false;
  private resumeWaiters: (() => void)[] = [];

  private readonly picked: PickedFile[];
  private readonly note: string;
  private readonly totalBytes: bigint;

  constructor(
    picked: PickedFile[],
    private readonly onChange: (s: SenderSnapshot) => void,
    note = "",
  ) {
    this.picked = picked;
    this.note = sanitizeNote(note);
    this.totalBytes = picked.reduce((sum, p) => sum + BigInt(p.file.size), 0n);
    this.statuses = describeFiles(picked).map((entry) => ({
      entry,
      state: "queued",
      transferred: 0n,
    }));
  }

  private emit(state?: SenderState): void {
    if (state) this.state = state;
    this.onChange({
      state: this.state,
      shareUrl: this.shareUrl,
      progress: this.meter.snapshot(),
      files: this.statuses,
      current: this.current,
      totalBytes: this.totalBytes,
      note: this.note,
      error: this.error,
      paused: this.userPaused,
    });
  }

  private fail(message: string): void {
    // Keep the first failure: later ones are usually consequences of it.
    //
    // A finished transfer is equally immune. The receiver closes the peer
    // connection the moment it has verified everything, which reaches us as
    // connectionState "failed" a beat after TRANSFER_VERIFIED — and without
    // this, a perfect transfer ends by replacing "Sent and verified" with
    // "could not open a connection".
    if (this.state === "failed" || this.state === "complete" || this.state === "declined") {
      return;
    }
    this.error = message;
    if (this.current >= 0 && this.statuses[this.current]) {
      this.statuses[this.current]!.state = "failed";
    }
    this.emit("failed");
    this.cleanup();
  }

  /** Create the session and return the link to share. */
  async start(): Promise<void> {
    if (this.picked.length === 0) {
      this.fail("No files were chosen.");
      return;
    }
    if (this.picked.length > MAX_FILES_PER_TRANSFER) {
      this.fail(
        `That is ${this.picked.length} files. One transfer carries at most ${MAX_FILES_PER_TRANSFER} — send them in batches.`,
      );
      return;
    }
    if (this.totalBytes > MAX_TRANSFER_BYTES) {
      this.fail(
        `That is ${formatBytes(this.totalBytes)} in total. The limit is ${formatBytes(MAX_TRANSFER_BYTES)}.`,
      );
      return;
    }
    if (this.totalBytes === 0n) {
      this.fail(this.picked.length === 1 ? "That file is empty." : "Those files are all empty.");
      return;
    }

    this.emit("creating");

    let creds: SessionCredentials;
    try {
      creds = await createSession();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "Could not create a transfer session.");
      return;
    }

    this.shareUrl = buildShareUrl(window.location.origin, creds.sessionId, creds.receiverToken);
    this.signaling = new SignalingChannel(creds.sessionId, "sender", creds.senderToken);

    try {
      await this.signaling.connect({
        onMessage: (msg) => void this.onSignal(msg),
        onClose: () => {
          // Once the data channel is up, signaling is no longer needed.
          // Only reached once reconnection is exhausted.
          if (this.state === "waiting" || this.state === "connecting") {
            this.fail(
              "Lost contact with the transfer service and could not get it back. " +
                "The link is no longer valid — start a new transfer.",
            );
          }
        },
      });
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "Could not reach the signaling service.");
      return;
    }

    this.emit("waiting");
  }

  private async onSignal(msg: SignalMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "peer-joined":
          await this.negotiate();
          break;
        case "answer":
          await this.pc?.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          await this.remoteReady?.();
          break;
        case "ice":
          this.queueCandidate(msg.candidate);
          break;
        case "peer-left":
          // Signaling only matters until the peer connection exists. After
          // that no signaling traffic flows at all during a transfer, so the
          // socket sits idle and proxies close it routinely — which says
          // nothing about the receiver. Once linked, the data channel is the
          // only honest signal, and it reports loss on its own.
          if (!this.linked) {
            this.fail("The receiver left before the transfer started.");
          }
          break;
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "Connection negotiation failed.");
    }
  }

  private addCandidate: ((c: RTCIceCandidateInit) => void) | null = null;
  private remoteReady: (() => Promise<void>) | null = null;

  /** Candidates that arrived before negotiation finished building the connection. */
  private earlyCandidates: RTCIceCandidateInit[] = [];

  private queueCandidate(c: RTCIceCandidateInit): void {
    if (this.addCandidate) this.addCandidate(c);
    else this.earlyCandidates.push(c);
  }

  private async negotiate(): Promise<void> {
    if (this.pc) return; // a re-joined peer must not restart negotiation mid-flight
    this.emit("connecting");

    const { pc, addRemoteCandidate, onRemoteDescriptionSet } = await createPeerConnection(this.signaling!);
    this.pc = pc;
    this.addCandidate = addRemoteCandidate;
    this.remoteReady = onRemoteDescriptionSet;

    for (const c of this.earlyCandidates.splice(0)) addRemoteCandidate(c);

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.fail(unreachableMessage());
    };

    const { control, data } = createChannels(pc);
    this.control = control;
    this.data = data;

    control.onmessage = (ev) => void this.onControl(ev);

    const sdp = await pc.createOffer();
    await pc.setLocalDescription(sdp);
    this.signaling!.send({ type: "offer", sdp: sdp.sdp! });

    await waitForOpen(control);
    await waitForOpen(data);
    this.linked = true;
    this.signaling?.retireReconnect();

    // Real peer loss shows up here, not on the signaling socket.
    data.onclose = () => {
      if (this.state === "transferring" || this.state === "verifying") {
        this.fail("The receiver disconnected before the transfer finished.");
      }
    };

    sendControl(control, { type: "HELLO", protocolVersion: PROTOCOL_VERSION, role: "sender" });

    this.manifest = {
      transferId: crypto.randomUUID(),
      chunkSize: negotiatedChunkSize(pc),
      totalBytes: this.totalBytes,
      files: this.statuses.map((s) => s.entry),
      note: this.note,
    };
    sendControl(control, manifestToMessage(this.manifest));
    this.emit("offering");
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
            `The other device speaks protocol v${msg.protocolVersion}, this one speaks v${PROTOCOL_VERSION}. One of you needs to reload.`,
          );
        }
        break;

      case "MANIFEST_ACCEPT":
        await this.sendBatch();
        break;

      // The receiver's disk is often slower than the link. It tells us when
      // its write backlog is too deep, so the backlog does not turn into
      // memory on its side.
      case "PAUSE":
        this.remotePaused = true;
        break;

      case "RESUME":
        this.remotePaused = false;
        this.wake();
        break;

      case "FILE_VERIFIED": {
        const status = this.statuses.find((s) => s.entry.fileId === msg.fileId);
        if (status) {
          status.state = "verified";
          this.emit();
        }
        break;
      }

      // The transfer is only finished when the receiver has every file
      // written and verified, not when we have pushed the last byte.
      case "TRANSFER_VERIFIED":
        this.emit("complete");
        break;

      case "MANIFEST_REJECT":
        this.emit("declined");
        this.cleanup();
        break;

      case "TRANSFER_FAILED":
        this.fail(msg.message || "The receiver reported a failure.");
        break;
    }
  }

  /**
   * The read loop, across the whole batch.
   *
   * Files stream back to back with no round trip between them: the receiver
   * knows every size from the manifest, so it can route bytes by counting.
   * Memory stays flat because only one chunk is resident at a time and the
   * loop blocks whenever a buffer is full.
   */
  private async sendBatch(): Promise<void> {
    const data = this.data;
    const manifest = this.manifest;
    if (!data || !manifest) return;

    this.meter.start(this.totalBytes);
    this.emit("transferring");

    data.bufferedAmountLowThreshold = BUFFER_LOW;
    sendControl(this.control!, { type: "TRANSFER_START", transferId: manifest.transferId });

    try {
      for (let i = 0; i < this.picked.length; i++) {
        if (this.cancelled) return;
        this.current = i;
        this.statuses[i]!.state = "sending";
        await this.sendOne(this.picked[i]!.file, this.statuses[i]!, manifest.chunkSize, data);
        this.statuses[i]!.state = "sent";
        this.emit();
      }

      this.current = -1;
      this.emit("verifying");

      // The last send() only queues bytes; control and data are separate SCTP
      // streams, so TRANSFER_COMPLETE would overtake whatever is still sitting
      // in the data channel's buffer and the receiver would see a short file.
      // Wait for the buffer to drain before announcing completion.
      await this.flush(data);
      sendControl(this.control!, { type: "TRANSFER_COMPLETE", transferId: manifest.transferId });

      // Stay in "verifying" until TRANSFER_VERIFIED arrives. The receiver may
      // still be writing a long backlog to disk, and telling the user it is
      // done while the other side is mid-write is how someone closes the tab
      // and ends up with an unopenable file.
    } catch (err) {
      sendControl(this.control!, {
        type: "TRANSFER_FAILED",
        transferId: manifest.transferId,
        code: "send_failed",
        message: "The sender could not finish the transfer.",
      });
      this.fail(err instanceof Error ? err.message : "The transfer failed.");
    }
  }

  /** Stream one file and announce its digest. */
  private async sendOne(
    file: File,
    status: FileStatus,
    chunkSize: number,
    data: RTCDataChannel,
  ): Promise<void> {
    const hasher = new StreamHasher();
    this.hasher = hasher;
    await hasher.init();

    try {
      let offset = 0;
      const total = file.size;

      while (offset < total) {
        if (this.cancelled) throw new Error("The transfer was cancelled.");
        if (data.readyState !== "open") throw new Error("The connection dropped mid-transfer.");

        if (this.remotePaused || this.userPaused) {
          await this.waitForResume();
          continue;
        }

        if (data.bufferedAmount > BUFFER_HIGH) {
          await this.drain(data);
          continue;
        }

        const end = Math.min(offset + chunkSize, total);
        // slice() is lazy — this reads only these bytes, never the whole file.
        const buf = await file.slice(offset, end).arrayBuffer();
        const length = buf.byteLength;

        data.send(buf);
        // send() has copied the bytes, so the buffer is free to transfer to
        // the hashing worker, which detaches it.
        await hasher.update(buf);

        offset = end;
        status.transferred = BigInt(offset);
        this.sentTotal += BigInt(length);
        this.meter.set(this.sentTotal);
        this.emit();
      }

      const sha256 = await hasher.final();
      sendControl(this.control!, { type: "FILE_DONE", fileId: status.entry.fileId, sha256 });
    } finally {
      hasher.destroy();
      if (this.hasher === hasher) this.hasher = null;
    }
  }

  /**
   * Wait until every queued byte has actually left, not merely dropped below
   * the low-water mark.
   *
   * ponytail: polls. `bufferedamountlow` does not re-fire once the threshold
   * is already satisfied, and retuning the threshold mid-flight is fiddly for
   * something that runs once per transfer.
   */
  private flush(data: RTCDataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => {
        clearInterval(timer);
        data.removeEventListener("bufferedamountlow", onLow);
        fn();
      };
      const tick = () => {
        if (data.bufferedAmount === 0) done(resolve);
        else if (data.readyState !== "open") {
          done(() => reject(new Error("The connection dropped before the last bytes were sent.")));
        }
      };

      // The event carries this in a backgrounded tab, where timers get
      // throttled to once a minute; the interval is only a safety net.
      const onLow = () => tick();
      data.bufferedAmountLowThreshold = 0;
      data.addEventListener("bufferedamountlow", onLow);
      const timer = setInterval(tick, 250);
      tick();
    });
  }

  /** Block the read loop until whatever paused it lets go. */
  private waitForResume(): Promise<void> {
    if (!this.remotePaused && !this.userPaused) return Promise.resolve();
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  private wake(): void {
    if (this.remotePaused || this.userPaused) return;
    for (const resume of this.resumeWaiters.splice(0)) resume();
  }

  /** Wait for the send buffer to drain below the low-water mark. */
  private drain(data: RTCDataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      const onLow = () => {
        data.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      data.addEventListener("bufferedamountlow", onLow);

      // A channel that closes while we are waiting would otherwise hang here
      // forever.
      if (data.readyState !== "open") {
        data.removeEventListener("bufferedamountlow", onLow);
        reject(new Error("The connection dropped mid-transfer."));
      }
    });
  }

  /**
   * Hold the transfer without dropping the connection.
   *
   * Purely local: the read loop stops pulling bytes, the send buffer drains,
   * and SCTP flow control does the rest. No protocol message is needed, and
   * the peer connection stays up so resuming is instant.
   */
  pause(): void {
    if (this.userPaused) return;
    this.userPaused = true;
    this.emit();
  }

  resume(): void {
    if (!this.userPaused) return;
    this.userPaused = false;
    this.wake();
    this.emit();
  }

  cancel(): void {
    this.cancelled = true;
    this.userPaused = false;
    this.wake();
    this.cleanup();
  }

  private cleanup(): void {
    this.hasher?.destroy();
    this.hasher = null;
    this.control?.close();
    this.data?.close();
    this.pc?.close();
    this.signaling?.close();
    this.pc = null;
    this.signaling = null;
  }
}
