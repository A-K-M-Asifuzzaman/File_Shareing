/**
 * Where received bytes go.
 *
 * The whole 100 GB claim rests on this file. A sink must never accumulate the
 * file in memory, in React state, or in one Blob — the only sink that can
 * honestly handle very large files is one that streams to disk as chunks
 * arrive.
 *
 * v2 receives a batch, so the unit here is a *destination*: something that
 * hands out one sink per file in manifest order and can recreate a folder
 * tree. Picking a destination is one user gesture for the whole batch rather
 * than one dialog per file.
 */

import { MEMORY_FALLBACK_LIMIT, formatBytes, type ManifestEntry } from "./protocol";

export interface WriteSink {
  write(chunk: ArrayBuffer): Promise<void>;
  /** Finish and hand the file to the user. */
  close(): Promise<void>;
  /** Give up and clean up any partial file. */
  abort(): Promise<void>;
}

export interface Destination {
  readonly kind: "disk" | "memory";
  /** Human-readable location, for telling the user where the files went. */
  readonly label: string;
  /** Open the sink for one file of the batch. */
  open(entry: ManifestEntry): Promise<WriteSink>;
  /** Called once the whole batch is done, successfully or not. */
  finish(ok: boolean): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* File System Access typings                                                 */
/* -------------------------------------------------------------------------- */

interface FileSystemWritableStream {
  write(data: ArrayBuffer | Blob): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface SaveFileHandle {
  readonly name: string;
  createWritable(): Promise<FileSystemWritableStream>;
}
interface DirectoryHandle {
  readonly name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<SaveFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirectoryHandle>;
  removeEntry?(name: string, opts?: { recursive?: boolean }): Promise<void>;
}
type ShowSaveFilePicker = (opts?: { suggestedName?: string }) => Promise<SaveFileHandle>;
type ShowDirectoryPicker = (opts?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandle>;

function savePicker(): ShowSaveFilePicker | null {
  if (typeof window === "undefined") return null;
  const fn = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  return typeof fn === "function" ? fn : null;
}

function directoryPicker(): ShowDirectoryPicker | null {
  if (typeof window === "undefined") return null;
  const fn = (window as unknown as { showDirectoryPicker?: ShowDirectoryPicker })
    .showDirectoryPicker;
  return typeof fn === "function" ? fn : null;
}

export function canStreamToDisk(): boolean {
  return savePicker() !== null;
}

export function canPickDirectory(): boolean {
  return directoryPicker() !== null;
}

/* -------------------------------------------------------------------------- */
/* Capability detection                                                       */
/* -------------------------------------------------------------------------- */

export interface Capability {
  /** Can this browser accept this batch without lying to the user? */
  ok: boolean;
  mode: "disk" | "memory" | "unsupported";
  message?: string;
}

/**
 * Decide honestly whether this browser can take the batch. We would rather
 * refuse up front than crash the tab 40 GB in.
 */
export function assessCapability(totalBytes: bigint, fileCount: number): Capability {
  if (canStreamToDisk()) {
    if (fileCount > 1 && !canPickDirectory()) {
      return {
        ok: true,
        mode: "disk",
        message: `This browser cannot pick a folder, so it will ask where to save each of the ${fileCount} files in turn.`,
      };
    }
    return { ok: true, mode: "disk" };
  }

  if (totalBytes <= BigInt(MEMORY_FALLBACK_LIMIT)) {
    return {
      ok: true,
      mode: "memory",
      message:
        `This browser cannot write directly to disk, so the transfer is held in memory until it finishes. ` +
        `That is fine at ${formatBytes(totalBytes)}.`,
    };
  }

  return {
    ok: false,
    mode: "unsupported",
    message:
      `This browser cannot safely write very large transfers directly to disk. ` +
      `It can accept up to ${formatBytes(MEMORY_FALLBACK_LIMIT)} this way, and this transfer is ${formatBytes(totalBytes)}. ` +
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
  constructor(
    private readonly stream: FileSystemWritableStream,
    private readonly onAbort?: () => Promise<void>,
  ) {}

  write(chunk: ArrayBuffer): Promise<void> {
    return this.stream.write(chunk);
  }
  close(): Promise<void> {
    return this.stream.close();
  }
  async abort(): Promise<void> {
    // The file already exists on disk — the picker or the directory handle
    // created it — and a bare abort() would leave a half-written file with a
    // real name and a plausible size: a movie that looks fine until it will
    // not play. Truncate to zero first so a failed transfer is unmistakable,
    // then delete it outright where we hold a directory handle.
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
    try {
      await this.onAbort?.();
    } catch {
      /* deleting is best-effort; the file is at least empty */
    }
  }
}

/**
 * Last resort for browsers without the File System Access API. Bounded by
 * MEMORY_FALLBACK_LIMIT across the whole batch and refuses to exceed it even
 * if the sender lies about the sizes in its manifest.
 */
class MemorySink implements WriteSink {
  private parts: ArrayBuffer[] = [];

  constructor(
    private readonly entry: ManifestEntry,
    private readonly budget: { used: number },
  ) {}

  async write(chunk: ArrayBuffer): Promise<void> {
    this.budget.used += chunk.byteLength;
    if (this.budget.used > MEMORY_FALLBACK_LIMIT) {
      this.parts = [];
      throw new Error(
        `Transfer exceeded the ${formatBytes(MEMORY_FALLBACK_LIMIT)} in-memory limit for this browser.`,
      );
    }
    this.parts.push(chunk);
  }

  async close(): Promise<void> {
    const blob = new Blob(this.parts, {
      type: this.entry.mimeType || "application/octet-stream",
    });
    this.parts = [];

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.entry.name;
    a.click();
    // Revoke on the next tick; revoking synchronously races the download.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async abort(): Promise<void> {
    this.parts = [];
  }
}

/* -------------------------------------------------------------------------- */
/* Destinations                                                               */
/* -------------------------------------------------------------------------- */

/** One save dialog for one file — the v1 path, kept for the common case. */
class SingleFileDestination implements Destination {
  readonly kind = "disk";
  constructor(
    readonly label: string,
    private readonly handle: SaveFileHandle,
  ) {}

  async open(): Promise<WriteSink> {
    return new DiskSink(await this.handle.createWritable());
  }
  async finish(): Promise<void> {}
}

/**
 * A folder the user picked. Files are created inside it as they arrive, so
 * one gesture covers the whole batch, and a sent folder tree is recreated
 * rather than flattened.
 */
class DirectoryDestination implements Destination {
  readonly kind = "disk";
  /** Names already used in this batch, per directory, so nothing overwrites. */
  private readonly taken = new Map<string, Set<string>>();

  constructor(
    readonly label: string,
    private readonly root: DirectoryHandle,
  ) {}

  async open(entry: ManifestEntry): Promise<WriteSink> {
    let dir = this.root;
    const segments = entry.path ? entry.path.split("/") : [];
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const key = entry.path;
    let used = this.taken.get(key);
    if (!used) {
      used = new Set<string>();
      this.taken.set(key, used);
    }

    const name = await uniqueName(dir, entry.name, used);
    used.add(name);

    const handle = await dir.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    // Remove the empty husk on failure — inside a directory we hold a handle
    // to, unlike the single-file path, we can actually delete it.
    return new DiskSink(stream, async () => {
      await dir.removeEntry?.(name);
    });
  }

  async finish(): Promise<void> {}
}

/**
 * No directory picker but a save picker: ask per file. Only reached on
 * browsers that have showSaveFilePicker and not showDirectoryPicker, which is
 * rare — and it still beats refusing the transfer.
 *
 * ponytail: each dialog after the first is outside a user gesture, so a
 * browser may block it. The user is warned in assessCapability(); a real fix
 * would be an OPFS staging area, which is a lot of machinery for a case that
 * barely exists.
 */
class PerFileDestination implements Destination {
  readonly kind = "disk";
  readonly label = "the locations you choose";

  async open(entry: ManifestEntry): Promise<WriteSink> {
    const picker = savePicker();
    if (!picker) throw new Error("This browser cannot save files directly to disk.");
    const handle = await picker({ suggestedName: entry.name });
    return new DiskSink(await handle.createWritable());
  }
  async finish(): Promise<void> {}
}

/** Downloads each file through the browser once it is whole. */
class MemoryDestination implements Destination {
  readonly kind = "memory";
  readonly label = "your downloads folder";
  private readonly budget = { used: 0 };

  async open(entry: ManifestEntry): Promise<WriteSink> {
    return new MemorySink(entry, this.budget);
  }
  async finish(): Promise<void> {}
}

/**
 * Pick a name that is free both on disk and within this batch.
 *
 * Silently replacing someone's file would be worse than an awkward name, so a
 * collision becomes "report (2).pdf".
 */
async function uniqueName(
  dir: DirectoryHandle,
  name: string,
  usedInBatch: Set<string>,
): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";

  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    if (usedInBatch.has(candidate)) continue;
    try {
      await dir.getFileHandle(candidate); // throws NotFoundError when free
    } catch {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * Open a destination for a batch.
 *
 * Must be called from a user gesture on the disk path — neither picker will
 * open otherwise.
 */
export async function openDestination(files: ManifestEntry[], totalBytes: bigint): Promise<Destination> {
  const cap = assessCapability(totalBytes, files.length);
  if (!cap.ok) throw new Error(cap.message);

  if (cap.mode === "memory") return new MemoryDestination();

  if (files.length === 1) {
    const picker = savePicker()!;
    // No `types`. The browser enforces the saved file's extension against the
    // extension list in an accept entry, so a type with an empty list can
    // strip the extension off the name — the bytes are fine but nothing will
    // open "holiday" that used to be "holiday.mkv". The extension already
    // travels in suggestedName, which is all we need.
    const handle = await picker({ suggestedName: files[0]!.name });
    return new SingleFileDestination(handle.name || files[0]!.name, handle);
  }

  const dirPicker = directoryPicker();
  if (!dirPicker) return new PerFileDestination();

  const dir = await dirPicker({ mode: "readwrite" });
  return new DirectoryDestination(dir.name || "the folder you chose", dir);
}
