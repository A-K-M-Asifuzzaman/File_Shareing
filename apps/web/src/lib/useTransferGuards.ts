"use client";

import { useEffect } from "react";

interface WakeLockSentinel {
  release(): Promise<void>;
  released: boolean;
}
interface WakeLockNavigator {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> };
}

/**
 * Keeps a transfer alive for as long as the browser will allow.
 *
 * Two things routinely kill a transfer on a phone: the screen turning off,
 * and the tab being closed by accident. We can prevent the first outright and
 * warn about the second.
 *
 * What we cannot do is keep transferring while the browser is in the
 * background. Mobile browsers freeze the page, and there is no web API that
 * exempts a WebRTC transfer from that — no worker or service worker survives
 * it either. The transfer resumes when the user comes back, which is the best
 * a web page can do; running through a backgrounded app needs the native
 * client.
 */
export function useTransferGuards(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const wakeLock = (navigator as Navigator & WakeLockNavigator).wakeLock;

    const acquire = async () => {
      if (!wakeLock || document.hidden || cancelled) return;
      try {
        sentinel = await wakeLock.request("screen");
      } catch {
        // Denied, unsupported, or the page lost visibility mid-request.
        // The transfer still works; the screen may just sleep.
      }
    };

    // The lock is dropped automatically whenever the page is hidden, so it
    // has to be taken again each time the user comes back.
    const onVisibility = () => {
      if (!document.hidden && (!sentinel || sentinel.released)) void acquire();
    };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // There is no copy anywhere else: closing this tab ends the transfer.
      e.preventDefault();
      e.returnValue = "";
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}
