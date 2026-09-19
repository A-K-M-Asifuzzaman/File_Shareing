import { createPeerConnection, sendControl } from "./connection";
import { StreamHasher } from "./hasher";
import {
  PROTOCOL_VERSION,
  isControlMessage,
  offerFromMessage,
  type ControlMessage,
  type FileOffer,
  type SignalMessage,
} from "./protocol";
import { ProgressMeter, type Progress } from "./progress";
import { assessCapability, openSink, type Capability, type WriteSink } from "./sink";
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

export interface ReceiverSnapshot {
  state: ReceiverState;
  offer: FileOffer | null;
  capability: Capability | null;
  progress: Progress;
  error: string | null;
  verified: boolean;
}

export class FileReceiver {
  private signaling: SignalingChannel | null = null;
  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private sink: WriteSink | null = null;
  private hasher: StreamHasher | null = null;
  private meter = new ProgressMeter();

  private state: ReceiverState = "connecting";
  private offer: FileOffer | null = null;
  private capability: Capability | null = null;
  private error: string | null = null;
  private verified = false;
  private received = 0n;

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
      offer: this.offer,
      capability: this.capability,
      progress: this.meter.snapshot(),
      error: this.error,
      verified: this.verified,
    });
  }

  private fail(message: string, state: ReceiverState = "failed"): void {
    if (this.state === "failed") return;
    this.error = message;
    void this.sink?.abort();
    this.sink = null;
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

    const { pc, addRemoteCandidate, onRemoteDescriptionSet } = createPeerConnection(this.signaling!);
    this.pc = pc;
    this.addCandidate = addRemoteCandidate;
    this.remoteReady = onRemoteDescriptionSet;

    // Replay anything that arrived while we were still parsing the offer.
    for (const c of this.earlyCandidates.splice(0)) addRemoteCandidate(c);

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.fail(
          "Could not open a direct connection to the sender. One of the two networks is blocking peer-to-peer traffic.",
        );
      }
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
        };
        ev.channel.onclose = () => {
          // Real peer loss, as opposed to a dropped signaling socket.
          if (this.state === "receiving") {
            this.fail("The sender disconnected before the transfer finished.", "senderGone");
          }
        };
        if (ev.channel.readyState === "open") this.linked = true;
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

      case "FILE_OFFER":
        try {
          this.offer = offerFromMessage(msg);
        } catch (err) {
          // A malformed offer means the far side is broken or hostile.
          this.fail(err instanceof Error ? err.message : "The sender sent an invalid file offer.");
          return;
        }
        this.capability = assessCapability(this.offer.size);
        this.emit("offered");
        break;

      case "TRANSFER_COMPLETE":
        await this.finish(msg.sha256);
        break;

      case "TRANSFER_FAILED":
        this.fail(msg.message || "The sender reported a failure.");
        break;
    }
  }

  /**
   * Accept and start receiving.
   *
   * Must be called directly from a click: the save dialog only opens inside a
   * user gesture, and nothing may be awaited before it.
   */
  async accept(): Promise<void> {
    const offer = this.offer;
    if (!offer || !this.control) return;

    try {
      this.sink = await openSink(offer.name, offer.mimeType, offer.size);
    } catch (err) {
      // A cancelled save dialog is a decision, not a failure.
      if (err instanceof DOMException && err.name === "AbortError") return;
      this.fail(err instanceof Error ? err.message : "Could not open a place to save the file.");
      return;
    }

    this.hasher = new StreamHasher();
    await this.hasher.init();

    this.received = 0n;
    this.meter.start(offer.size);
    this.emit("receiving");

    sendControl(this.control, { type: "FILE_ACCEPT", fileId: offer.fileId });
  }

  decline(): void {
    if (this.control && this.offer) {
      sendControl(this.control, {
        type: "FILE_REJECT",
        fileId: this.offer.fileId,
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

  private onChunk(ev: MessageEvent): void {
    const chunk = ev.data as ArrayBuffer;
    this.writes = this.writes.then(() => this.writeChunk(chunk));
  }

  private async writeChunk(chunk: ArrayBuffer): Promise<void> {
    if (!this.sink || !this.hasher || !this.offer) return;

    const size = chunk.byteLength;

    // The sender is a stranger. Refuse more bytes than it said it would send
    // rather than letting it write unbounded data to the user's disk.
    if (this.received + BigInt(size) > this.offer.size) {
      this.fail("The sender sent more data than it declared. Transfer aborted.");
      return;
    }

    try {
      await this.sink.write(chunk);
      // write() has consumed the bytes, so the buffer can be transferred to
      // the hashing worker, which detaches it.
      await this.hasher.update(chunk);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "Could not write the file to disk.");
      return;
    }

    this.received += BigInt(size);
    this.meter.set(this.received);
    this.emit();
  }

  private async finish(expectedSha256: string): Promise<void> {
    this.emit("verifying");

    // TRANSFER_COMPLETE can arrive while the last chunks are still being
    // written, so let the queue drain before deciding the file is short.
    await this.writes.catch(() => undefined);

    if (!this.sink || !this.hasher || !this.offer) return;

    // A short file that claims completion is a failed transfer, not a
    // successful one.
    if (this.received !== this.offer.size) {
      sendControl(this.control!, {
        type: "TRANSFER_FAILED",
        fileId: this.offer.fileId,
        code: "short_read",
        message: "Receiver got fewer bytes than declared.",
      });
      this.fail("The transfer ended early. The received file is incomplete.");
      return;
    }

    const actual = await this.hasher.final();
    this.hasher.destroy();
    this.hasher = null;

    if (!expectedSha256 || actual !== expectedSha256) {
      await this.sink.abort();
      this.sink = null;
      this.fail("File verification failed. The received file may be incomplete or corrupted.");
      return;
    }

    try {
      await this.sink.close();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "Could not finish writing the file.");
      return;
    }

    this.sink = null;
    this.verified = true;
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
