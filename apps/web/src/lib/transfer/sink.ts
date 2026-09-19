/**
 * Where received bytes go.
 *
 * The whole 100 GB claim rests on this file. A sink must never accumulate the
 * file in memory, in React state, or in one Blob — the only sink that can
 * honestly handle very large files is one that streams to disk as chunks
 * arrive.
 */

import { MEMORY_FALLBACK_LIMIT, formatBytes } from "./protocol";

export interface WriteSink {
  write(chunk: ArrayBuffer): Promise<void>;
  /** Finish and hand the file to the user. */
  close(): Promise<void>;
  /** Give up and clean up any partial file. */
  abort(): Promise<void>;
  readonly kind: "disk" | "memory";
}

/* -------------------------------------------------------------------------- */
/* Capability detection                                                       */
/* -------------------------------------------------------------------------- */

interface FileSystemWritableStream {
  write(data: ArrayBuffer | Blob): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface SaveFileHandle {
  createWritable(): Promise<FileSystemWritableStream>;
}
type ShowSaveFilePicker = (opts?: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveFileHandle>;

function savePicker(): ShowSaveFilePicker | null {
  if (typeof window === "undefined") return null;
  const fn = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  return typeof fn === "function" ? fn : null;
}

export function canStreamToDisk(): boolean {
  return savePicker() !== null;
}

export interface Capability {
  /** Can this browser accept a file of this size without lying to the user? */
  ok: boolean;
  mode: "disk" | "memory" | "unsupported";
  message?: string;
}

/**
 * Decide honestly whether this browser can take the file. We would rather
 * refuse up front than crash the tab 40 GB in.
 */
export function assessCapability(size: bigint): Capability {
  if (canStreamToDisk()) return { ok: true, mode: "disk" };

  if (size <= BigInt(MEMORY_FALLBACK_LIMIT)) {
    return {
      ok: true,
      mode: "memory",
      message: `This browser cannot write directly to disk, so the file is held in memory until it finishes. That is fine at ${formatBytes(size)}.`,
    };
  }

  return {
    ok: false,
    mode: "unsupported",
    message:
      `This browser cannot safely write very large files directly to disk. ` +
      `It can accept up to ${formatBytes(MEMORY_FALLBACK_LIMIT)} this way, and this file is ${formatBytes(size)}. ` +
      `Use a Chromium-based browser on desktop for transfers this size.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Sinks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Streams straight to a file the user picked. Memory stays flat regardless of
 * file size, which is the entire point.
 */
class DiskSink implements WriteSink {
  readonly kind = "disk";
  constructor(private stream: FileSystemWritableStream) {}

  write(chunk: ArrayBuffer): Promise<void> {
    return this.stream.write(chunk);
  }
  close(): Promise<void> {
    return this.stream.close();
  }
  async abort(): Promise<void> {
    // The file already exists on disk — the save dialog created it — and we
    // cannot delete it from here. Aborting alone would leave a half-written
    // file with a real name and a plausible size: a movie that looks fine
    // until it will not play. Truncate to zero first so a failed transfer is
    // unmistakable.
    try {
      await this.stream.truncate(0);
    } catch {
      /* truncate is best-effort; still abort below */
    }
    try {
      await this.stream.abort();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Last resort for browsers without the File System Access API. Bounded by
 * MEMORY_FALLBACK_LIMIT and refuses to exceed it even if the sender lies
 * about the size in its offer.
 */
class MemorySink implements WriteSink {
  readonly kind = "memory";
  private parts: ArrayBuffer[] = [];
  private bytes = 0;

  constructor(
    private readonly filename: string,
    private readonly mimeType: string,
  ) {}

  async write(chunk: ArrayBuffer): Promise<void> {
    this.bytes += chunk.byteLength;
    if (this.bytes > MEMORY_FALLBACK_LIMIT) {
      this.parts = [];
      throw new Error(
        `Transfer exceeded the ${formatBytes(MEMORY_FALLBACK_LIMIT)} in-memory limit for this browser.`,
      );
    }
    this.parts.push(chunk);
  }

  async close(): Promise<void> {
    const blob = new Blob(this.parts, { type: this.mimeType || "application/octet-stream" });
    this.parts = [];

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.filename;
    a.click();
    // Revoke on the next tick; revoking synchronously races the download.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async abort(): Promise<void> {
    this.parts = [];
  }
}

/**
 * Open a sink. Must be called from a user gesture on the disk path — the save
 * picker will not open otherwise.
 */
export async function openSink(
  filename: string,
  mimeType: string,
  size: bigint,
): Promise<WriteSink> {
  const cap = assessCapability(size);
  if (!cap.ok) throw new Error(cap.message);

  if (cap.mode === "disk") {
    const picker = savePicker()!;

    // No `types`. The browser enforces the saved file's extension against the
    // extension list in an accept entry, so a type with an empty list can
    // strip the extension off the name — the bytes are fine but nothing will
    // open "holiday" that used to be "holiday.mkv". The extension already
    // travels in suggestedName, which is all we need.
    const handle = await picker({ suggestedName: filename });
    return new DiskSink(await handle.createWritable());
  }

  return new MemorySink(filename, mimeType);
}
