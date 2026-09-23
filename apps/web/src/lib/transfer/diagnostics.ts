"use client";

import { iceServers, relayAvailable } from "./connection";
import { MEMORY_FALLBACK_LIMIT, formatBytes } from "./protocol";
import { prefetchIce, signalingHealth } from "./signaling";
import { canPickDirectory, canStreamToDisk } from "./sink";

/**
 * A self-test for the things that actually stop a transfer.
 *
 * "Could not open a direct connection" is the one failure this product cannot
 * fix from the inside, and it is indistinguishable, from the user's side, from
 * the app being broken. This page is the difference between "it doesn't work"
 * and "your network only gives relay candidates and no relay is configured" —
 * which is a thing someone can act on.
 *
 * Everything here runs locally and against our own signaling service. No
 * transfer is created and no peer is involved.
 */

export type Verdict = "pass" | "warn" | "fail" | "pending";

export interface Check {
  id: string;
  label: string;
  verdict: Verdict;
  detail: string;
}

/** Instant, synchronous capability checks. */
export function environmentChecks(): Check[] {
  const checks: Check[] = [];

  const rtc = typeof RTCPeerConnection !== "undefined";
  checks.push({
    id: "webrtc",
    label: "WebRTC",
    verdict: rtc ? "pass" : "fail",
    detail: rtc
      ? "This browser can open a peer connection."
      : "Without WebRTC this browser cannot transfer at all.",
  });

  const workers = typeof Worker !== "undefined";
  const wasm = typeof WebAssembly !== "undefined";
  checks.push({
    id: "hashing",
    label: "Checksums off the main thread",
    verdict: workers && wasm ? "pass" : "fail",
    detail:
      workers && wasm
        ? "Web Workers and WebAssembly are available, so SHA-256 runs without freezing the page."
        : "Hashing needs Web Workers and WebAssembly; without them a transfer cannot be verified.",
  });

  const disk = canStreamToDisk();
  const dir = canPickDirectory();
  checks.push({
    id: "disk",
    label: "Writing straight to disk",
    verdict: disk ? "pass" : "warn",
    detail: disk
      ? dir
        ? "Files stream to disk as they arrive, and a whole folder can be received in one go."
        : "Files stream to disk, but this browser cannot pick a folder, so a multi-file transfer asks per file."
      : `This browser holds a received transfer in memory, so it is capped at ${formatBytes(MEMORY_FALLBACK_LIMIT)}. Sending is unaffected.`,
  });

  const gl = (() => {
    try {
      return Boolean(document.createElement("canvas").getContext("webgl"));
    } catch {
      return false;
    }
  })();
  checks.push({
    id: "webgl",
    label: "WebGL backdrop",
    verdict: gl ? "pass" : "warn",
    detail: gl
      ? "The live transfer field renders."
      : "No WebGL. Purely cosmetic — transfers are unaffected.",
  });

  const wake = "wakeLock" in navigator;
  checks.push({
    id: "wakelock",
    label: "Keeping the screen awake",
    verdict: wake ? "pass" : "warn",
    detail: wake
      ? "A long transfer can hold the screen on so the device does not sleep mid-flight."
      : "No Wake Lock API, so the device may sleep during a long transfer. Keep the screen on.",
  });

  return checks;
}

/** Is the signaling service up, and how far away is it? */
export async function checkSignaling(): Promise<Check> {
  const started = performance.now();
  const ok = await signalingHealth();
  const ms = Math.round(performance.now() - started);

  if (!ok) {
    return {
      id: "signaling",
      label: "Transfer service",
      verdict: "fail",
      detail:
        "The signaling service did not answer. Without it two browsers cannot find each other — check your connection, or try again in a minute if it is waking up.",
    };
  }
  return {
    id: "signaling",
    label: "Transfer service",
    verdict: ms > 2000 ? "warn" : "pass",
    detail:
      ms > 2000
        ? `Answered in ${ms} ms — it was probably asleep. The next transfer will be quicker.`
        : `Answered in ${ms} ms.`,
  };
}

export interface IceResult {
  check: Check;
  /** Candidate types that were gathered, in the order ICE reports them. */
  types: string[];
  /** Public IP as seen from outside, if a server-reflexive candidate appeared. */
  publicAddress: string | null;
}

/**
 * Gather ICE candidates and report what kind of path this network allows.
 *
 * `host` alone means a direct connection only works on the same LAN.
 * `srflx` means STUN saw us through the NAT, which is what makes most
 * connections across the internet possible. `relay` means TURN answered, which
 * is the fallback for networks that permit nothing else.
 */
export async function checkIce(timeoutMs = 8000): Promise<IceResult> {
  await prefetchIce();

  if (typeof RTCPeerConnection === "undefined") {
    return {
      check: {
        id: "ice",
        label: "Network path",
        verdict: "fail",
        detail: "No WebRTC, so no path can be tested.",
      },
      types: [],
      publicAddress: null,
    };
  }

  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const types = new Set<string>();
  let publicAddress: string | null = null;

  try {
    // A data channel is what makes the browser gather candidates at all.
    pc.createDataChannel("probe");

    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return done(); // null candidate ends gathering
        const c = ev.candidate;
        if (c.type) types.add(c.type);
        if (c.type === "srflx" && c.address) publicAddress = c.address;
      };

      void pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(done);
    });
  } finally {
    pc.close();
  }

  const list = [...types];
  const relay = list.includes("relay");
  const srflx = list.includes("srflx");

  let verdict: Verdict = "fail";
  let detail: string;

  if (relay) {
    verdict = "pass";
    detail =
      "A relay is reachable, so a connection can be made even on networks that block direct paths.";
  } else if (srflx) {
    verdict = "pass";
    detail = publicAddress
      ? `STUN saw this device at ${publicAddress}, so a direct connection across the internet should work.`
      : "STUN reached us through the NAT, so a direct connection across the internet should work.";
  } else if (list.includes("host")) {
    verdict = "warn";
    detail = relayAvailable()
      ? "Only local candidates were gathered. Transfers on the same network will work; anything further will fall back to the relay."
      : "Only local candidates were gathered — STUN did not get through. Transfers will work between devices on the same Wi-Fi, but probably not across the internet, and no relay is configured.";
  } else {
    detail = "No candidates at all. Something is blocking WebRTC entirely — often a VPN, an extension, or a corporate policy.";
  }

  return {
    check: { id: "ice", label: "Network path", verdict, detail },
    types: list,
    publicAddress,
  };
}
