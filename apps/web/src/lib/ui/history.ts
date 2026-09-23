"use client";

import { useSyncExternalStore } from "react";

/**
 * A local record of what has been sent and received.
 *
 * Deliberately only a record: names, sizes and outcomes, never bytes and never
 * a link — a stored link would be a live capability sitting in localStorage.
 * It never leaves the device, which is the whole point of the product, so it
 * lives in localStorage rather than anywhere a server could see it.
 */

export interface HistoryItem {
  id: string;
  at: number;
  direction: "sent" | "received";
  /** First file's name, plus a count when there were more. */
  label: string;
  fileCount: number;
  bytes: string;
  outcome: "complete" | "failed" | "declined";
  /** Seconds the transfer took, when it got far enough to have taken any. */
  seconds: number | null;
}

const KEY = "direct.history";
const LIMIT = 40;

let cache: HistoryItem[] | null = null;
const listeners = new Set<() => void>();

function load(): HistoryItem[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as HistoryItem[]).slice(0, LIMIT) : [];
  } catch {
    // Unreadable or blocked storage is not worth failing a transfer over.
    cache = [];
  }
  return cache;
}

function save(items: HistoryItem[]): void {
  cache = items;
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Quota or private mode: the list still works for this session.
  }
  for (const fn of listeners) fn();
}

export function record(item: Omit<HistoryItem, "id" | "at">): void {
  if (typeof window === "undefined") return;
  save([{ ...item, id: crypto.randomUUID(), at: Date.now() }, ...load()].slice(0, LIMIT));
}

export function clearHistory(): void {
  save([]);
}

const EMPTY: HistoryItem[] = [];

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useHistory(): { items: HistoryItem[]; clear: () => void } {
  // clearHistory is already a stable module-level function; wrapping it in a
  // useCallback would only add a hook to memoise something that never changes.
  const items = useSyncExternalStore(subscribe, load, () => EMPTY);
  return { items, clear: clearHistory };
}
