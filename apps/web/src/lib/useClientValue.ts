"use client";

import { useSyncExternalStore } from "react";

const neverChanges = () => () => {};

/**
 * Read a value that only exists in the browser — a feature check, the URL
 * fragment — without an effect.
 *
 * Returns undefined during server rendering and the first hydration pass, so
 * callers can tell "not known yet" apart from a real answer instead of
 * flashing the wrong state.
 *
 * `read` must return a primitive or a stable reference; a fresh object each
 * call would spin React in a loop.
 */
export function useClientValue<T>(read: () => T): T | undefined {
  return useSyncExternalStore<T | undefined>(neverChanges, read, () => undefined);
}
