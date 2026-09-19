import {
  createChannels,
  createPeerConnection,
  negotiatedChunkSize,
  sendControl,
  waitForOpen,
} from "./connection";
import { StreamHasher } from "./hasher";
import {
  MAX_TRANSFER_BYTES,
  PROTOCOL_VERSION,
  formatBytes,
  isControlMessage,
  offerToMessage,
  type ControlMessage,
  type FileOffer,
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

export interface SenderSnapshot {
  state: SenderState;
  shareUrl: string | null;
  progress: Progress;
  error: string | null;
  fileName: string | null;
  fileSize: bigint | null;
}

/**
 * Buffer threshold for backpressure. Sending until the buffer is full is what
 * turns a 100 GB transfer into a crashed tab; we top the queue up to 1 MB and
 * then wait for it to drain.
 */
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;

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
  private offer: FileOffer | null = null;

  /** True once both data channels are open and signaling stops mattering. */
  private linked = false;

  /** Set while the receiver's write backlog is too deep for more data. */
  private paused = false;
  private resumeWaiters: (() => void)[] = [];

  constructor(
    private readonly file: File,
    private readonly onChange: (s: SenderSnapshot) => void,
  ) {}

  private emit(state?: SenderState): void {
    if (state) this.state = state;
    this.onChange({
      state: this.state,
      shareUrl: this.shareUrl,
      progress: this.meter.snapshot(),
      error: this.error,
      fileName: this.file.name,
      fileSize: BigInt(this.file.size),
    });
  }

  private fail(message: string): void {
    // Keep the first failure: later ones are usually consequences of it.
    if (this.state === "failed") return;
    this.error = message;
    this.emit("failed");
    this.cleanup();
  }

  /** Create the session and return the link to share. */
  async start(): Promise<void> {
    if (BigInt(this.file.size) > MAX_TRANSFER_BYTES) {
      this.fail(`That file is ${formatBytes(this.file.size)}. The limit is ${formatBytes(MAX_TRANSFER_BYTES)}.`);
      return;
    }
    if (this.file.size === 0) {
      this.fail("That file is empty.");
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

    const { pc, addRemoteCandidate, onRemoteDescriptionSet } = createPeerConnection(this.signaling!);
    this.pc = pc;
    this.addCandidate = addRemoteCandidate;
    this.remoteReady = onRemoteDescriptionSet;

    for (const c of this.earlyCandidates.splice(0)) addRemoteCandidate(c);

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.fail(
          "Could not open a direct connection. This is usually mobile data or a " +
            "restrictive Wi-Fi — the quickest thing to try is putting both devices on " +
            "the same Wi-Fi network. Getting through anyway needs a relay server, " +
            "which is not configured.",
        );
      }
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

    this.offer = {
      transferId: crypto.randomUUID(),
      fileId: crypto.randomUUID(),
      name: this.file.name,
      size: BigInt(this.file.size),
      mimeType: this.file.type || "application/octet-stream",
      lastModified: this.file.lastModified,
      chunkSize: negotiatedChunkSize(pc),
    };
    sendControl(control, offerToMessage(this.offer));
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
      case "FILE_ACCEPT":
        await this.sendFile();
        break;

      // The receiver's disk is often slower than the link. It tells us when
      // its write backlog is too deep, so the backlog does not turn into
      // memory on its side.
      case "PAUSE":
        this.paused = true;
        break;

      case "RESUME":
        this.paused = false;
        for (const wake of this.resumeWaiters.splice(0)) wake();
        break;

      // The transfer is only finished when the receiver has the file written
      // and verified, not when we have pushed the last byte.
      case "TRANSFER_VERIFIED":
        this.emit("complete");
        break;
      case "FILE_REJECT":
        this.emit("declined");
        this.cleanup();
        break;
      case "TRANSFER_FAILED":
        this.fail(msg.message || "The receiver reported a failure.");
        break;
    }
  }

  /**
   * The read loop. Memory stays flat because only one chunk is resident at a
   * time and the loop blocks whenever the send buffer is full.
   */
  private async sendFile(): Promise<void> {
    const data = this.data;
    const offer = this.offer;
    if (!data || !offer) return;

    this.meter.start(BigInt(this.file.size));
    this.emit("transferring");

    this.hasher = new StreamHasher();
    await this.hasher.init();

    data.bufferedAmountLowThreshold = BUFFER_LOW;
    sendControl(this.control!, { type: "TRANSFER_START", fileId: offer.fileId });

    let offset = 0;
    const total = this.file.size;
    const chunkSize = offer.chunkSize;

    try {
      while (offset < total) {
        if (this.cancelled) return;
        if (data.readyState !== "open") throw new Error("The connection dropped mid-transfer.");

        if (this.paused) {
          await this.waitForResume();
          continue;
        }

        if (data.bufferedAmount > BUFFER_HIGH) {
          await this.drain(data);
          continue;
        }

        const end = Math.min(offset + chunkSize, total);
        // slice() is lazy — this reads only these bytes, never the whole file.
        const buf = await this.file.slice(offset, end).arrayBuffer();

        data.send(buf);
        // send() has copied the bytes, so the buffer is free to transfer to
        // the hashing worker, which detaches it.
        await this.hasher.update(buf);

        offset = end;
        this.meter.set(BigInt(offset));
        this.emit();
      }

      this.emit("verifying");
      const sha256 = await this.hasher.final();

      // The last send() only queues bytes; control and data are separate SCTP
      // streams, so TRANSFER_COMPLETE would overtake whatever is still sitting
      // in the data channel's buffer and the receiver would see a short file.
      // Wait for the buffer to drain before announcing completion.
      await this.flush(data);

      sendControl(this.control!, { type: "TRANSFER_COMPLETE", fileId: offer.fileId, sha256 });

      // Stay in "verifying" until TRANSFER_VERIFIED arrives. The receiver may
      // still be writing a long backlog to disk, and telling the user it is
      // done while the other side is mid-write is how someone closes the tab
      // and ends up with an unopenable file.
    } catch (err) {
      sendControl(this.control!, {
        type: "TRANSFER_FAILED",
        fileId: offer.fileId,
        code: "send_failed",
        message: "The sender could not finish the transfer.",
      });
      this.fail(err instanceof Error ? err.message : "The transfer failed.");
    } finally {
      this.hasher?.destroy();
      this.hasher = null;
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

  /** Block the read loop until the receiver says it has caught up. */
  private waitForResume(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
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

  cancel(): void {
    this.cancelled = true;
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
