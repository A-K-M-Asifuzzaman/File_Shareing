"use client";

import { pickedFromInput, type PickedFile } from "@/lib/transfer/sender";

/**
 * Files out of a drop or a paste, folders included.
 *
 * `DataTransfer.files` flattens a dropped folder to nothing — the folder is
 * simply absent from the list. The entries API is the only way to see inside
 * one, and it is a callback tree, so this walks it and keeps the relative path
 * as it goes. Dropping a folder is the most natural way to send one, and
 * losing it silently would be worse than not offering it.
 */

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(cb: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(cb: (e: FileSystemEntryLike[]) => void, err: (e: unknown) => void): void };
}

/** Guard against a symlink loop or a pathological tree stalling the page. */
const MAX_DEPTH = 16;
const MAX_FILES = 2000;

export async function filesFromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const items = Array.from(dt.items ?? []);
  // The DOM's own FileSystemEntry type is wider than what is actually
  // implemented and varies by browser, so this reads it through a shape of
  // exactly what is used and nothing more.
  const entries = items
    .map((item) => item.webkitGetAsEntry?.() as FileSystemEntryLike | null | undefined)
    .filter((e): e is FileSystemEntryLike => e != null);

  // No entries API, or a paste rather than a drop: the flat list is all there is.
  if (entries.length === 0) return pickedFromInput(dt.files);

  const out: PickedFile[] = [];
  for (const entry of entries) {
    await walk(entry, "", out, 0);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

async function walk(
  entry: FileSystemEntryLike,
  path: string,
  out: PickedFile[],
  depth: number,
): Promise<void> {
  if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;

  if (entry.isFile) {
    const file = await readFile(entry);
    if (file) out.push({ file, path });
    return;
  }
  if (!entry.isDirectory) return;

  const here = path ? `${path}/${entry.name}` : entry.name;
  for (const child of await readDirectory(entry)) {
    await walk(child, here, out, depth + 1);
  }
}

function readFile(entry: FileSystemEntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.file) return resolve(null);
    entry.file(resolve, () => resolve(null));
  });
}

/**
 * readEntries hands back at most ~100 entries per call and signals the end
 * with an empty batch, so a big folder has to be drained in a loop.
 */
async function readDirectory(entry: FileSystemEntryLike): Promise<FileSystemEntryLike[]> {
  const reader = entry.createReader?.();
  if (!reader) return [];

  const all: FileSystemEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) break;
    all.push(...batch);
    if (all.length >= MAX_FILES) break;
  }
  return all;
}
