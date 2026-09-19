"use client";

import { useState } from "react";

/**
 * The share link plus a copy button.
 *
 * The capability lives in the fragment, so the whole string matters — showing
 * a truncated link that cannot be pasted would be worse than useless. It
 * wraps instead.
 */
export function ShareLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked by permissions; the text is selectable anyway.
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
      <div className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-3.5 py-3">
        <p className="tabular text-[13px] leading-relaxed break-all text-ink-soft">{url}</p>
      </div>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-lg bg-signal px-4 py-3 text-[14px] font-medium text-signal-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
