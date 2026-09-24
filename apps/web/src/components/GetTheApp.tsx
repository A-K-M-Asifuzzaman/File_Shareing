"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useClientValue } from "@/lib/useClientValue";

const DISMISSED = "direct.app-pill.dismissed";

/** Stable and primitive, as useClientValue requires. */
function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false; // private mode, blocked storage: still offer it
  }
}

/**
 * A standing offer of the Android app, without becoming furniture.
 *
 * Floating, because the app is the answer to the question this site raises on
 * every page — what happens if I close the tab — and that question does not
 * only get asked on the page about the app. Dismissible and remembered,
 * because an advert you cannot turn off is not an offer.
 *
 * Hidden on /android, where it would point at the page you are reading, and
 * on /t/, where the only thing that matters is the transfer in front of you.
 */
export function GetTheApp() {
  const pathname = usePathname();
  // undefined until hydration: the dismissal lives in this browser and the
  // server cannot know it, so the pill stays off rather than flashing at
  // someone who already closed it.
  const dismissed = useClientValue(wasDismissed);
  const [closed, setClosed] = useState(false);

  function dismiss() {
    setClosed(true);
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {
      /* nothing to remember it with; it comes back next load */
    }
  }

  if (dismissed !== false || closed) return null;
  if (pathname === "/android" || pathname.startsWith("/t/")) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-end p-4 sm:p-6">
      <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-line bg-panel/95 p-1.5 shadow-lg backdrop-blur-sm">
        <Link
          href="/android"
          className="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-panel-soft"
        >
          <Mark />
          <span className="flex flex-col leading-tight">
            <span className="text-[13.5px] font-medium tracking-tight">Get the Android app</span>
            <span className="text-[11.5px] text-ink-faint">
              Transfers keep running in the background
            </span>
          </span>
        </Link>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide the Android app offer"
          className="self-stretch rounded-xl px-2.5 text-[15px] text-ink-faint transition-colors hover:bg-panel-soft hover:text-ink-soft"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

/** The product mark, at the size a pill can carry. */
function Mark() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 32 32"
      aria-hidden="true"
      className="shrink-0 rounded-lg"
    >
      <rect width="32" height="32" rx="8" className="fill-ground-deep" />
      <circle cx="8" cy="16" r="3.5" className="fill-ink" />
      <path
        d="M13 16h6"
        className="stroke-signal"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="2.5 3.5"
      />
      <circle cx="24" cy="16" r="3.5" className="fill-none stroke-signal" strokeWidth="2.5" />
    </svg>
  );
}
