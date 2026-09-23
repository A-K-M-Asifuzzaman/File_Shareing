"use client";

/**
 * Tell someone their transfer finished when they are not looking at the tab.
 *
 * A 100 GB transfer runs for hours, and nobody watches a progress bar for
 * hours — they switch away, which is exactly when the result matters most.
 *
 * Only ever fired for a terminal state, and only while the page is hidden:
 * a notification for something already on screen is noise, and asking for
 * permission before there is anything to say is the reason people block
 * notifications in the first place.
 */

export function canNotify(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationState(): NotificationPermission | "unsupported" {
  return canNotify() ? Notification.permission : "unsupported";
}

/** Ask, from a user gesture. Returns whether we may notify afterwards. */
export async function askToNotify(): Promise<boolean> {
  if (!canNotify()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export function notify(title: string, body: string): void {
  if (!canNotify() || Notification.permission !== "granted") return;
  if (!document.hidden) return;
  try {
    const n = new Notification(title, { body, tag: "direct-transfer", icon: "/icon.svg" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker. Nothing
    // to do about it here, and it must not break the transfer.
  }
}
