"use client";

import { formatBytes, formatDuration, formatRate } from "@/lib/transfer/protocol";
import type { Progress } from "@/lib/transfer/progress";

export type LinkPhase = "idle" | "waiting" | "live" | "done" | "error";

/**
 * Two endpoints and the path between them.
 *
 * The graphic carries connection state so the page does not need a separate
 * status widget: dormant, breathing while waiting, flowing while bytes move,
 * solid when finished.
 */
export function Endpoints({
  phase,
  from = "You",
  to = "Them",
}: {
  phase: LinkPhase;
  from?: string;
  to?: string;
}) {
  const live = phase === "live";
  const done = phase === "done";
  const error = phase === "error";

  const pathColor = error ? "stroke-danger" : live || done ? "stroke-signal" : "stroke-line";

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <svg
        viewBox="0 0 240 48"
        className="h-12 w-full max-w-[280px]"
        role="img"
        aria-label={`Connection ${phase}`}
      >
        {/* origin */}
        <circle cx="24" cy="24" r="7" className="fill-ink" />

        {/* path */}
        <path
          d="M38 24h164"
          className={pathColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={done ? undefined : "4 6"}
        />
        {live && (
          <path
            d="M38 24h164"
            className="stroke-signal flowing"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="4 6"
          />
        )}

        {/* destination */}
        <circle
          cx="216"
          cy="24"
          r="7"
          className={done || live ? "fill-signal" : "fill-none stroke-ink-faint"}
          strokeWidth="2"
        />
        {phase === "waiting" && (
          <circle cx="216" cy="24" r="7" className="fill-signal breathing" />
        )}
      </svg>

      <div className="flex w-full max-w-[280px] justify-between text-[12px] text-ink-faint">
        <span>{from}</span>
        <span>{to}</span>
      </div>
    </div>
  );
}

export function ProgressReadout({ progress, label }: { progress: Progress; label: string }) {
  const pct = Math.min(100, Math.max(0, progress.fraction * 100));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[14px] text-ink-soft">{label}</span>
        <span className="tabular text-[22px] font-medium">{pct.toFixed(1)}%</span>
      </div>

      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-signal transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <dl className="tabular grid grid-cols-3 gap-3 text-[13px]">
        <Stat label="Transferred" value={formatBytes(progress.transferred)} />
        <Stat label="Rate" value={formatRate(progress.bytesPerSecond)} />
        <Stat
          label="Remaining"
          value={progress.etaSeconds === null ? "—" : formatDuration(progress.etaSeconds)}
        />
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "good";
  children: React.ReactNode;
}) {
  const styles = {
    info: "border-line bg-panel text-ink-soft",
    error: "border-danger/30 bg-danger-wash text-danger",
    good: "border-signal/30 bg-signal-wash text-ink",
  }[tone];

  return (
    <p className={`rounded-lg border px-3.5 py-3 text-[13px] leading-relaxed ${styles}`}>
      {children}
    </p>
  );
}

export function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-6 sm:p-8">{children}</div>
  );
}

export function FileLine({ name, size }: { name: string; size: bigint | number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line pb-4">
      <p className="min-w-0 truncate text-[15px] font-medium" title={name}>
        {name}
      </p>
      <p className="tabular shrink-0 text-[14px] text-ink-soft">{formatBytes(size)}</p>
    </div>
  );
}
