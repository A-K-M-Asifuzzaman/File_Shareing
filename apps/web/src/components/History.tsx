"use client";

import { formatBytes, formatDuration } from "@/lib/transfer/protocol";
import { useHistory, type HistoryItem } from "@/lib/ui/history";

/**
 * What this device has sent and received.
 *
 * It exists because the product deliberately keeps no record anywhere else:
 * once a transfer ends there is no dashboard to check, so without this there
 * is no way to answer "did that 40 GB actually go through". It holds names,
 * sizes and outcomes only — never a link, which would be a live capability
 * sitting in storage, and never any bytes.
 */
export function History() {
  const { items, clear } = useHistory();
  if (items.length === 0) return null;

  return (
    <section className="mx-auto w-full max-w-6xl px-5 pt-16">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <p className="eyebrow">On this device only</p>
          <h2 className="mt-2 text-[20px] font-medium tracking-tight">Recent transfers</h2>
        </div>
        <button
          type="button"
          onClick={clear}
          className="text-[13px] text-ink-faint underline-offset-4 hover:text-ink-soft hover:underline"
        >
          Clear
        </button>
      </div>

      <ul className="mt-6 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
        {items.slice(0, 8).map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function Row({ item }: { item: HistoryItem }) {
  const tone =
    item.outcome === "complete"
      ? "text-signal"
      : item.outcome === "declined"
        ? "text-ink-faint"
        : "text-danger";

  const extra = item.fileCount > 1 ? ` and ${item.fileCount - 1} more` : "";

  return (
    <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
      <Arrow direction={item.direction} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px]">
          {item.label}
          {extra && <span className="text-ink-faint">{extra}</span>}
        </p>
        <p className="tabular mt-0.5 text-[11px] text-ink-faint">
          {formatBytes(BigInt(item.bytes))}
          {item.seconds ? ` · ${formatDuration(item.seconds)}` : ""} ·{" "}
          <time dateTime={new Date(item.at).toISOString()}>{when(item.at)}</time>
        </p>
      </div>

      <span className={`shrink-0 text-[12px] ${tone}`}>
        {item.outcome === "complete" ? "verified" : item.outcome}
      </span>
    </li>
  );
}

function Arrow({ direction }: { direction: HistoryItem["direction"] }) {
  const sent = direction === "sent";
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0 text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      role="img"
      aria-label={sent ? "Sent" : "Received"}
    >
      <path
        d={sent ? "M8 13V3M4.5 6.5L8 3l3.5 3.5" : "M8 3v10M4.5 9.5L8 13l3.5-3.5"}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Relative where it helps, absolute once "3 days ago" stops meaning anything. */
function when(at: number): string {
  const seconds = (Date.now() - at) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(at).toLocaleDateString();
}
