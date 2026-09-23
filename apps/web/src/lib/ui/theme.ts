"use client";

import { useSyncExternalStore } from "react";

/**
 * Two independent axes.
 *
 * The scheme decides how bright the room is; the accent decides which colour
 * the product spends on "something is happening". They are stored separately
 * because they are chosen for different reasons — a dark room in the evening
 * is not a change of mind about the accent.
 */
export type Scheme = "system" | "light" | "dark";
export type Accent = "signal" | "ion" | "ember" | "violet" | "bone";

export const ACCENTS: { value: Accent; label: string; note: string }[] = [
  { value: "signal", label: "Signal", note: "Lime on black, deep green on paper" },
  { value: "ion", label: "Ion", note: "Cold cyan" },
  { value: "ember", label: "Ember", note: "Warm amber" },
  { value: "violet", label: "Violet", note: "Soft lavender" },
  { value: "bone", label: "Bone", note: "No accent at all" },
];

const SCHEME_KEY = "direct.theme";
const ACCENT_KEY = "direct.accent";

const isScheme = (v: unknown): v is "light" | "dark" => v === "light" || v === "dark";
const isAccent = (v: unknown): v is Accent =>
  typeof v === "string" && ACCENTS.some((a) => a.value === v);

/**
 * The script that runs before first paint.
 *
 * Reading the stored choice in React would mean one frame of the wrong theme,
 * which on this palette is a white flash on a black page. Inlined in <head>
 * instead, so <html> carries both attributes before anything is drawn. Wrapped
 * so a blocked localStorage cannot throw the page away, and deliberately
 * tolerant of junk in storage: an unknown value falls through to the default
 * rather than writing a broken attribute the CSS has no rule for.
 */
export const THEME_SCRIPT = `try{var d=document.documentElement,s=localStorage.getItem(${JSON.stringify(
  SCHEME_KEY,
)}),a=localStorage.getItem(${JSON.stringify(ACCENT_KEY)});if(s==="light"||s==="dark")d.dataset.theme=s;if(${JSON.stringify(
  ACCENTS.map((a) => a.value),
)}.indexOf(a)>0)d.dataset.accent=a}catch(e){}`;

function readScheme(): Scheme {
  if (typeof document === "undefined") return "system";
  const attr = document.documentElement.dataset.theme;
  return isScheme(attr) ? attr : "system";
}

function readAccent(): Accent {
  if (typeof document === "undefined") return "signal";
  const attr = document.documentElement.dataset.accent;
  return isAccent(attr) ? attr : "signal";
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const fn of listeners) fn();
};
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function remember(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode, or site data blocked. The choice still applies to this
    // page; it just will not be remembered.
  }
}

/**
 * Wear the transition class for the length of the change.
 *
 * Two frames of grace before it comes off: removing it in the same task as
 * the attribute swap means the browser never has a chance to interpolate, and
 * the transition simply does not happen.
 */
let settle: ReturnType<typeof setTimeout> | undefined;
function crossFade(change: () => void): void {
  const root = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!still) root.classList.add("theming");
  change();

  clearTimeout(settle);
  settle = setTimeout(() => root.classList.remove("theming"), 260);
}

export function setScheme(scheme: Scheme): void {
  crossFade(() => {
    const root = document.documentElement;
    if (scheme === "system") delete root.dataset.theme;
    else root.dataset.theme = scheme;
    remember(SCHEME_KEY, scheme === "system" ? null : scheme);
  });
  notify();
}

export function setAccent(accent: Accent): void {
  crossFade(() => {
    const root = document.documentElement;
    // "signal" is the default the CSS already carries; leaving the attribute
    // off keeps the DOM honest about what was actually chosen.
    if (accent === "signal") delete root.dataset.accent;
    else root.dataset.accent = accent;
    remember(ACCENT_KEY, accent === "signal" ? null : accent);
  });
  notify();
}

/** The current choices. Defaults until hydration, so server and client agree. */
export function useScheme(): Scheme {
  return useSyncExternalStore(subscribe, readScheme, () => "system");
}

export function useAccent(): Accent {
  return useSyncExternalStore(subscribe, readAccent, () => "signal");
}
