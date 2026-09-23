/**
 * Wire protocol v2. Mirrors protocol/README.md — change both together.
 *
 * Deliberately free of React and of any browser API so the same shapes can be
 * ported to Dart for the mobile client.
 *
 * v2 replaces v1's single-file exchange with a manifest: one offer describes
 * the whole batch, and the files then stream back to back over the data
 * channel with no per-file round trip. A single file is a batch of one, so
 * there is no second code path.
 */

export const PROTOCOL_VERSION = 2;

/** 100 GB, decimal. The number the UI shows is the number we enforce. */
export const MAX_TRANSFER_BYTES = 100_000_000_000n;

/** A batch cannot be unbounded either — this caps the file count. */
export const MAX_FILES_PER_TRANSFER = 500;

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

/** One file inside a manifest, as it crosses the wire. */
export interface ManifestEntryWire {
  fileId: string;
  /** Display name, no directory separators. */
  name: string;
  /** Relative path inside the batch when a folder was sent; "" otherwise. */
  path: string;
  size: string;
  mimeType: string;
  lastModified: number;
}

/**
 * Byte counts cross the wire as decimal strings. Go and Dart have a real
 * int64 and JavaScript does not, so a bare JSON number would round through a
 * float64 on one leg of the trip. See protocol/README.md.
 */
export type ControlMessage =
  | { type: "HELLO"; protocolVersion: number; role: Role }
  | {
      type: "MANIFEST";
      transferId: string;
      chunkSize: number;
      totalBytes: string;
      files: ManifestEntryWire[];
      /** Optional note the sender typed alongside the files. */
      note?: string;
    }
  | { type: "MANIFEST_ACCEPT"; transferId: string }
  | { type: "MANIFEST_REJECT"; transferId: string; reason: string }
  | { type: "TRANSFER_START"; transferId: string }
  // Sent after the last byte of a file. Control and data are separate SCTP
  // streams, so this can overtake the file's tail — the receiver holds it
  // until its own byte count says the file is whole.
  | { type: "FILE_DONE"; fileId: string; sha256: string }
  | { type: "FILE_VERIFIED"; fileId: string }
  | { type: "PAUSE"; transferId: string }
  | { type: "RESUME"; transferId: string; fromOffset: string }
  | { type: "TRANSFER_COMPLETE"; transferId: string }
  // Sent by the receiver once every file is written and its hash checked. The
  // sender waits for this before telling anyone the transfer succeeded.
  | { type: "TRANSFER_VERIFIED"; transferId: string }
  | { type: "TRANSFER_FAILED"; transferId: string; code: string; message: string };

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

export interface ManifestEntry {
  fileId: string;
  name: string;
  /** Sanitized relative path, or "" for a file sent on its own. */
  path: string;
  size: bigint;
  mimeType: string;
  lastModified: number;
}

export interface Manifest {
  transferId: string;
  chunkSize: number;
  totalBytes: bigint;
  files: ManifestEntry[];
  note: string;
}

export function manifestToMessage(m: Manifest): ControlMessage {
  return {
    type: "MANIFEST",
    transferId: m.transferId,
    chunkSize: m.chunkSize,
    totalBytes: m.totalBytes.toString(),
    note: m.note || undefined,
    files: m.files.map((f) => ({
      fileId: f.fileId,
      name: f.name,
      path: f.path,
      size: f.size.toString(),
      mimeType: f.mimeType,
      lastModified: f.lastModified,
    })),
  };
}

/**
 * Parse a MANIFEST from an untrusted peer. Everything is validated: the
 * sender is a stranger on the internet, and `name` and `path` in particular
 * end up in the DOM and in a save dialog.
 */
export function manifestFromMessage(m: ControlMessage): Manifest {
  if (m.type !== "MANIFEST") throw new Error(`expected MANIFEST, got ${m.type}`);

  if (!Array.isArray(m.files) || m.files.length === 0) {
    throw new Error("the manifest lists no files");
  }
  if (m.files.length > MAX_FILES_PER_TRANSFER) {
    throw new Error(`a transfer can carry at most ${MAX_FILES_PER_TRANSFER} files`);
  }
  if (!Number.isInteger(m.chunkSize) || m.chunkSize < 1024 || m.chunkSize > 1024 * 1024) {
    throw new Error("chunk size out of range");
  }

  const files: ManifestEntry[] = m.files.map((f) => {
    const size = parseByteCount(f.size, "size");
    if (size <= 0n) throw new Error("file size must be positive");
    return {
      fileId: String(f.fileId).slice(0, 128),
      name: sanitizeFilename(f.name),
      path: sanitizePath(f.path),
      size,
      mimeType: String(f.mimeType ?? "").slice(0, 255),
      lastModified: Number.isFinite(f.lastModified) ? f.lastModified : Date.now(),
    };
  });

  // Trust our own arithmetic over the sender's claimed total.
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0n);
  if (totalBytes > MAX_TRANSFER_BYTES) {
    throw new Error(`the transfer exceeds the ${formatBytes(MAX_TRANSFER_BYTES)} limit`);
  }

  const declared = parseByteCount(m.totalBytes, "totalBytes");
  if (declared !== totalBytes) throw new Error("the manifest's total does not match its files");

  return {
    transferId: String(m.transferId).slice(0, 128),
    chunkSize: m.chunkSize,
    totalBytes,
    files,
    note: sanitizeNote(m.note),
  };
}

/** Byte counts are decimal strings on the wire; reject anything else. */
export function parseByteCount(raw: string, field: string): bigint {
  if (typeof raw !== "string" || !/^\d{1,20}$/.test(raw)) {
    throw new Error(`${field} must be a decimal string`);
  }
  return BigInt(raw);
}

/** Drop C0 controls and DEL, which would mangle the UI or a filename. */
function printable(raw: unknown): string {
  return Array.from(String(raw ?? ""))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
}

/**
 * A filename from a remote peer is attacker-controlled. Strip directory
 * separators and traversal so it cannot escape wherever the receiver saves it,
 * and drop control characters that would mangle the UI.
 */
export function sanitizeFilename(raw: unknown): string {
  // Keep only the last path segment. A peer sending "../../etc/passwd" gets
  // "passwd" — no separators survive, so there is nothing left to traverse
  // with, and the result is still a usable filename.
  const base = printable(raw).split(/[/\\]/).pop() ?? "";

  // Leading dots would make it hidden, and "." / ".." are not filenames.
  const cleaned = base.replace(/^\.+/, "").trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : "received-file";
}

/**
 * A relative directory path from a remote peer, for recreating a sent folder.
 *
 * Every segment goes through the same rules as a filename, and any segment
 * that sanitizes to nothing — "..", ".", "" — is dropped rather than
 * substituted, so a hostile path collapses toward the chosen directory
 * instead of climbing out of it. Windows separators are normalised, and a
 * drive letter or UNC prefix cannot survive because ":" is not a separator
 * and the segment is still relative.
 */
export function sanitizePath(raw: unknown): string {
  const segments = printable(raw)
    .split(/[/\\]/)
    .map((seg) => seg.replace(/^\.+/, "").trim().slice(0, 200))
    .filter((seg) => seg.length > 0);

  // A pathological depth is not worth recreating on someone's disk.
  return segments.slice(0, 16).join("/");
}

/** The sender's note is free text that lands in the DOM; keep it short and clean. */
export function sanitizeNote(raw: unknown): string {
  if (raw == null) return "";
  return Array.from(String(raw))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code === 0x0a || (code > 0x1f && code !== 0x7f);
    })
    .join("")
    .slice(0, 2000);
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

/** "3 files" / "1 file", for the many places that say it. */
export function countFiles(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}
