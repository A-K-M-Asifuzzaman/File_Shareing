/**
 * Wire protocol v1. Mirrors protocol/README.md — change both together.
 *
 * Deliberately free of React and of any browser API so the same shapes can be
 * ported to Dart for the mobile client.
 */

export const PROTOCOL_VERSION = 1;

/** 100 GB, decimal. The number the UI shows is the number we enforce. */
export const MAX_TRANSFER_BYTES = 100_000_000_000n;

/** Default chunk size; clamped at runtime to the negotiated SCTP maximum. */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/**
 * Above this, a receiver without streaming-to-disk support must refuse rather
 * than try to hold the file in memory. 256 MB is already generous for a Blob.
 */
export const MEMORY_FALLBACK_LIMIT = 256 * 1024 * 1024;

export type Role = "sender" | "receiver";

/* -------------------------------------------------------------------------- */
/* Signaling                                                                  */
/* -------------------------------------------------------------------------- */

export type SignalMessage =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: "peer-joined"; detail: Role }
  | { type: "peer-left"; detail: Role }
  | { type: "peer-absent"; detail: string }
  | { type: "error"; detail: string };

/* -------------------------------------------------------------------------- */
/* Control channel                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Byte counts cross the wire as decimal strings. Go and Dart have a real
 * int64 and JavaScript does not, so a bare JSON number would round through a
 * float64 on one leg of the trip. See protocol/README.md.
 */
export type ControlMessage =
  | { type: "HELLO"; protocolVersion: number; role: Role }
  | {
      type: "FILE_OFFER";
      transferId: string;
      fileId: string;
      name: string;
      size: string;
      mimeType: string;
      lastModified: number;
      chunkSize: number;
    }
  | { type: "FILE_ACCEPT"; fileId: string }
  | { type: "FILE_REJECT"; fileId: string; reason: string }
  | { type: "TRANSFER_START"; fileId: string }
  | { type: "PAUSE"; fileId: string }
  | { type: "RESUME"; fileId: string; fromOffset: string }
  | { type: "CHECKPOINT"; fileId: string; receivedBytes: string }
  | { type: "TRANSFER_COMPLETE"; fileId: string; sha256: string }
  // Sent by the receiver once the file is written and its hash checked. The
  // sender waits for this before telling anyone the transfer succeeded.
  | { type: "TRANSFER_VERIFIED"; fileId: string }
  | { type: "TRANSFER_FAILED"; fileId: string; code: string; message: string };

export interface FileOffer {
  transferId: string;
  fileId: string;
  name: string;
  size: bigint;
  mimeType: string;
  lastModified: number;
  chunkSize: number;
}

export function offerToMessage(o: FileOffer): ControlMessage {
  return {
    type: "FILE_OFFER",
    transferId: o.transferId,
    fileId: o.fileId,
    name: o.name,
    size: o.size.toString(),
    mimeType: o.mimeType,
    lastModified: o.lastModified,
    chunkSize: o.chunkSize,
  };
}

/**
 * Parse a FILE_OFFER from an untrusted peer. Everything is validated: the
 * sender is a stranger on the internet, and `name` in particular ends up in
 * the DOM and in a save dialog.
 */
export function offerFromMessage(m: ControlMessage): FileOffer {
  if (m.type !== "FILE_OFFER") throw new Error(`expected FILE_OFFER, got ${m.type}`);

  const size = parseByteCount(m.size, "size");
  if (size <= 0n) throw new Error("file size must be positive");
  if (size > MAX_TRANSFER_BYTES) {
    throw new Error(`file exceeds the ${formatBytes(MAX_TRANSFER_BYTES)} limit`);
  }
  if (!Number.isInteger(m.chunkSize) || m.chunkSize < 1024 || m.chunkSize > 1024 * 1024) {
    throw new Error("chunk size out of range");
  }

  return {
    transferId: String(m.transferId).slice(0, 128),
    fileId: String(m.fileId).slice(0, 128),
    name: sanitizeFilename(m.name),
    size,
    mimeType: String(m.mimeType ?? "").slice(0, 255),
    lastModified: Number.isFinite(m.lastModified) ? m.lastModified : Date.now(),
    chunkSize: m.chunkSize,
  };
}

/** Byte counts are decimal strings on the wire; reject anything else. */
export function parseByteCount(raw: string, field: string): bigint {
  if (typeof raw !== "string" || !/^\d{1,20}$/.test(raw)) {
    throw new Error(`${field} must be a decimal string`);
  }
  return BigInt(raw);
}

/**
 * A filename from a remote peer is attacker-controlled. Strip directory
 * separators and traversal so it cannot escape wherever the receiver saves it,
 * and drop control characters that would mangle the UI.
 */
export function sanitizeFilename(raw: unknown): string {
  const printable = Array.from(String(raw ?? ""))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f; // drop C0 controls and DEL
    })
    .join("");

  // Keep only the last path segment. A peer sending "../../etc/passwd" gets
  // "passwd" — no separators survive, so there is nothing left to traverse
  // with, and the result is still a usable filename.
  const base = printable.split(/[/\\]/).pop() ?? "";

  // Leading dots would make it hidden, and "." / ".." are not filenames.
  const cleaned = base.replace(/^\.+/, "").trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : "received-file";
}

export function isControlMessage(v: unknown): v is ControlMessage {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

/* -------------------------------------------------------------------------- */
/* Display helpers                                                            */
/* -------------------------------------------------------------------------- */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Decimal units, matching how the 100 GB limit is defined. */
export function formatBytes(bytes: bigint | number): string {
  let n = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (!Number.isFinite(n) || n < 0) return "—";

  let unit = 0;
  while (n >= 1000 && unit < UNITS.length - 1) {
    n /= 1000;
    unit++;
  }
  const digits = unit === 0 ? 0 : n < 10 ? 1 : 0;
  return `${n.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;

  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;

  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
