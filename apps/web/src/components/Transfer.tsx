"use client";

import { formatBytes, formatDuration, formatRate } from "@/lib/transfer/protocol";
import type { Progress } from "@/lib/transfer/progress";

export type LinkPhase = "idle" | "waiting" | "live" | "done" | "error";

/**
 * Two endpoints and the path between them.
 *
 * The graphic carries connection state so the page needs no separate status
 * widget: dormant, breathing while waiting, flowing while bytes move, solid
 * when finished.
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

  const pathColor = error ? "stroke-danger" : live || done ? "stroke-signal" : "stroke-line-strong";

  return (
    <div className="flex flex-col items-center gap-3">
      <svg
        viewBox="0 0 240 48"
        className="h-14 w-full max-w-[320px]"
        role="img"
        aria-label={`Connection ${phase}`}
      >
        {done && (
          <circle cx="216" cy="24" r="13" className="fill-signal" opacity="0.14" />
        )}

        <circle cx="24" cy="24" r="7" className="fill-ink" />

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
            className="flowing stroke-signal"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="4 6"
          />
        )}

        <circle
          cx="216"
          cy="24"
          r="7"
          className={done || live ? "fill-signal" : "fill-none stroke-ink-faint"}
          strokeWidth="2"
        />
        {phase === "waiting" && (
          <circle cx="216" cy="24" r="7" className="breathing fill-signal" />
        )}
      </svg>

      <div className="flex w-full max-w-[320px] justify-between text-[11px] tracking-wide text-ink-faint uppercase">
        <span>{from}</span>
        <span>{to}</span>
      </div>
    </div>
  );
}

export function ProgressReadout({ progress, label }: { progress: Progress; label: string }) {
  const pct = Math.min(100, Math.max(0, progress.fraction * 100));
  const moving = progress.bytesPerSecond > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[14px] text-ink-soft">{label}</span>
        <span className="tabular text-[28px] leading-none font-medium tracking-tight">
          {pct.toFixed(1)}
          <span className="text-[16px] text-ink-faint">%</span>
        </span>
      </div>

      <div
        className={`relative h-2 w-full overflow-hidden rounded-full bg-line ${
          moving ? "sweeping" : ""
        }`}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-signal transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <dl className="tabular grid grid-cols-3 gap-3 border-t border-line pt-4 text-[13px]">
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
    <div className="flex flex-col gap-1">
      <dt className="text-[10px] tracking-[0.12em] text-ink-faint uppercase">{label}</dt>
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
    info: "border-line bg-panel-soft text-ink-soft",
    error: "border-danger/30 bg-danger-wash text-danger",
    good: "border-signal/40 bg-signal-wash text-ink",
  }[tone];

  return (
    <p className={`rounded-xl border px-4 py-3.5 text-[13px] leading-relaxed ${styles}`}>
      {children}
    </p>
  );
}

/**
 * Shown only where it is actually true.
 *
 * Desktop browsers keep a transfer running in a background tab. Phones freeze
 * the page the moment you leave the browser, and no web API exempts a WebRTC
 * transfer from that — so the honest thing is to say so up front rather than
 * let someone switch apps and come back to a stalled bar.
 */
export function ForegroundHint() {
  const touch =
    typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  if (!touch) return null;

  return (
    <p className="rounded-xl border border-line bg-panel-soft px-4 py-3.5 text-[13px] leading-relaxed text-ink-soft">
      Keep this tab in front. Leaving the browser pauses the transfer until you come back —
      the screen is being held awake in the meantime.
    </p>
  );
}

/** The frosted card everything sits on, over the field. */
export function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="glass rise rounded-2xl border border-line p-6 shadow-[var(--shadow-lift)] sm:p-8">
      {children}
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl bg-signal px-6 py-3.5 text-[15px] font-medium text-signal-ink transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99]"
    >
      {children}
    </button>
  );
}

export function QuietButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-line px-6 py-3.5 text-[15px] transition-colors duration-200 hover:border-line-strong hover:bg-ground-deep"
    >
      {children}
    </button>
  );
}

export function FileLine({ name, size }: { name: string; size: bigint | number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line pb-5">
      <p className="min-w-0 truncate text-[16px] font-medium tracking-tight" title={name}>
        {name}
      </p>
      <p className="tabular shrink-0 text-[14px] text-ink-soft">{formatBytes(size)}</p>
    </div>
  );
}
