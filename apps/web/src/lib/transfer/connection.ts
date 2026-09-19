import { DEFAULT_CHUNK_SIZE, type ControlMessage, type SignalMessage } from "./protocol";
import { currentIce, type SignalingChannel } from "./signaling";

/**
 * ICE servers for a new connection.
 *
 * Comes from the signaling service, which is the only place TURN credentials
 * can safely be minted. Falls back to STUN, which is enough whenever a direct
 * path exists at all.
 */
export function iceServers(): RTCIceServer[] {
  return currentIce().iceServers;
}

/** Whether a relay is available, so failures can say the right thing. */
export function relayAvailable(): boolean {
  return currentIce().relayAvailable;
}

export interface Channels {
  control: RTCDataChannel;
  data: RTCDataChannel;
}

/**
 * Wires ICE candidate exchange onto an existing signaling channel. Candidates
 * that arrive before the remote description is set are buffered — otherwise
 * addIceCandidate throws and the connection quietly fails to form.
 */
export function createPeerConnection(signaling: SignalingChannel): {
  pc: RTCPeerConnection;
  addRemoteCandidate: (init: RTCIceCandidateInit) => void;
  onRemoteDescriptionSet: () => Promise<void>;
} {
  const pc = new RTCPeerConnection({ iceServers: iceServers() });

  pc.onicecandidate = (ev) => {
    if (ev.candidate) signaling.send({ type: "ice", candidate: ev.candidate.toJSON() });
  };

  const buffered: RTCIceCandidateInit[] = [];
  let remoteReady = false;

  return {
    pc,
    addRemoteCandidate(init) {
      if (!remoteReady) {
        buffered.push(init);
        return;
      }
      void pc.addIceCandidate(init).catch(() => {
        // A rejected candidate is normal — others usually still work.
      });
    },
    async onRemoteDescriptionSet() {
      remoteReady = true;
      for (const c of buffered.splice(0)) {
        await pc.addIceCandidate(c).catch(() => undefined);
      }
    },
  };
}

/**
 * Both channels are ordered and reliable. That is what lets chunks travel
 * without any per-chunk header: SCTP guarantees the receiver sees them in the
 * order they were sent, so position is just a running byte count.
 */
export function createChannels(pc: RTCPeerConnection): Channels {
  const control = pc.createDataChannel("control", { ordered: true });
  const data = pc.createDataChannel("data", { ordered: true });
  data.binaryType = "arraybuffer";
  return { control, data };
}

export function sendControl(channel: RTCDataChannel, msg: ControlMessage): void {
  if (channel.readyState === "open") channel.send(JSON.stringify(msg));
}

/**
 * The negotiated SCTP limit varies by browser and by the remote end. Sending a
 * message larger than it closes the connection, so read what was actually
 * negotiated instead of trusting our default.
 */
export function negotiatedChunkSize(pc: RTCPeerConnection): number {
  const max = pc.sctp?.maxMessageSize;
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) return DEFAULT_CHUNK_SIZE;
  // Leave headroom under the limit rather than sitting exactly on it.
  return Math.max(1024, Math.min(DEFAULT_CHUNK_SIZE, Math.floor(max * 0.8)));
}

export function waitForOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    channel.onopen = () => resolve();
    channel.onerror = () => reject(new Error(`Data channel "${channel.label}" failed to open.`));
  });
}

export function isSignal<T extends SignalMessage["type"]>(
  msg: SignalMessage,
  type: T,
): msg is Extract<SignalMessage, { type: T }> {
  return msg.type === type;
}
