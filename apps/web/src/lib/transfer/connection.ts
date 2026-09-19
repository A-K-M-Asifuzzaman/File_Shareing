import { DEFAULT_CHUNK_SIZE, type ControlMessage, type SignalMessage } from "./protocol";
import type { SignalingChannel } from "./signaling";

export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [];

  // Empty means "host candidates only" — useful on a LAN and in tests, where
  // reaching a public STUN server is neither possible nor needed.
  const stun = (process.env.NEXT_PUBLIC_STUN_URLS ?? "stun:stun.l.google.com:19302")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (stun.length > 0) servers.push({ urls: stun });

  // TURN relays file bytes through a third party, so it is opt-in. Without it,
  // a pair behind symmetric NAT simply cannot connect — which we say plainly
  // rather than silently routing their file somewhere they did not expect.
  const turn = process.env.NEXT_PUBLIC_TURN_URL;
  if (turn) {
    servers.push({
      urls: turn,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return servers;
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
