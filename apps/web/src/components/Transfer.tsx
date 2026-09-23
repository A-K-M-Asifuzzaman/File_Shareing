"use client";

import { Sparkline } from "@/components/Sparkline";
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
        {done && <circle cx="216" cy="24" r="13" className="fill-signal" opacity="0.14" />}

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
        {phase === "waiting" && <circle cx="216" cy="24" r="7" className="breathing fill-signal" />}
      </svg>

      <div className="flex w-full max-w-[320px] justify-between text-[11px] tracking-wide text-ink-faint uppercase">
        <span>{from}</span>
        <span>{to}</span>
      </div>
    </div>
  );
}

export function ProgressReadout({
  progress,
  label,
  paused = false,
}: {
  progress: Progress;
  label: string;
  paused?: boolean;
}) {
  const pct = Math.min(100, Math.max(0, progress.fraction * 100));
  const moving = progress.bytesPerSecond > 0 && !paused;

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

      {/* Shape of the last half-minute, not a second copy of the rate. */}
      <Sparkline values={progress.history} />

      <dl className="tabular grid grid-cols-2 gap-3 border-t border-line pt-4 text-[13px] sm:grid-cols-4">
        <Stat label="Moved" value={formatBytes(progress.transferred)} />
        <Stat label="Rate" value={paused ? "paused" : formatRate(progress.bytesPerSecond)} />
        <Stat
          label="Remaining"
          value={
            paused || progress.etaSeconds === null ? "—" : formatDuration(progress.etaSeconds)
          }
        />
        <Stat label="Elapsed" value={formatDuration(progress.elapsedSeconds)} />
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
  tone?: "info" | "error" | "good" | "warn";
  children: React.ReactNode;
}) {
  const styles = {
    info: "border-line bg-panel-soft text-ink-soft",
    error: "border-danger/30 bg-danger-wash text-danger",
    good: "border-signal/40 bg-signal-wash text-ink",
    warn: "border-warn/30 bg-warn-wash text-warn",
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
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  if (!touch) return null;

  return (
    <p className="rounded-xl border border-line bg-panel-soft px-4 py-3.5 text-[13px] leading-relaxed text-ink-soft">
      Keep this tab in front. Leaving the browser pauses the transfer until you come back — the
      screen is being held awake in the meantime.
    </p>
  );
}

/**
 * Waiting on something with no measurable progress.
 *
 * A line of static text is indistinguishable from a frozen page, and this
 * particular wait can run to most of a minute when the signaling service has
 * to wake up. So: something visibly moving, and an explanation that surfaces
 * itself only once the wait has gone on long enough to worry about — on a CSS
 * delay, so no timer has to be managed to say it.
 */
export function Working({ label, patience }: { label: string; patience?: string }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-line bg-panel-soft px-4 py-3.5"
      role="status"
      aria-live="polite"
    >
      <p className="text-[13px] text-ink-soft">{label}</p>
      <div className="indeterminate h-1 w-full rounded-full bg-line" />
      {patience && <p className="later text-[12px] leading-relaxed text-ink-faint">{patience}</p>}
    </div>
  );
}

/** The frosted card everything sits on, over the field. */
export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`glass rise rounded-2xl border border-line p-6 shadow-[var(--shadow-lift)] sm:p-8 ${className}`}
    >
      {children}
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-xl bg-signal px-6 py-3.5 text-[15px] font-medium text-signal-ink transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function QuietButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-xl border border-line px-6 py-3.5 text-[15px] transition-colors duration-200 hover:border-line-strong hover:bg-ground-deep"
    >
      {children}
    </button>
  );
}

/** The headline for a batch: what it is, and how big. */
export function BatchLine({
  files,
  totalBytes,
}: {
  files: { name: string }[];
  totalBytes: bigint;
}) {
  const first = files[0]?.name ?? "";
  const rest = files.length - 1;

  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line pb-5">
      <p className="min-w-0 truncate text-[16px] font-medium tracking-tight" title={first}>
        {first}
        {rest > 0 && (
          <span className="text-ink-faint">
            {" "}
            and {rest} more
          </span>
        )}
      </p>
      <p className="tabular shrink-0 text-[14px] text-ink-soft">{formatBytes(totalBytes)}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The per-file list                                                          */
/* -------------------------------------------------------------------------- */

export type RowState = "queued" | "sending" | "receiving" | "sent" | "verified" | "failed";

export interface QueueRow {
  id: string;
  name: string;
  path: string;
  size: bigint;
  transferred: bigint;
  state: RowState;
}

/**
 * Every file in the batch, with its own progress.
 *
 * On a 200-file folder the overall bar says almost nothing — "which file is it
 * stuck on" is the only question worth answering, and that needs the list.
 * Scrolls inside the panel rather than pushing the controls off the screen.
 */
export function FileQueue({ rows, onRemove }: { rows: QueueRow[]; onRemove?: (id: string) => void }) {
  if (rows.length === 0) return null;

  return (
    <ul className="quiet-scroll flex max-h-64 flex-col divide-y divide-line overflow-y-auto rounded-xl border border-line bg-panel-soft">
      {rows.map((row) => (
        <FileRow key={row.id} row={row} onRemove={onRemove} />
      ))}
    </ul>
  );
}

function FileRow({ row, onRemove }: { row: QueueRow; onRemove?: (id: string) => void }) {
  const active = row.state === "sending" || row.state === "receiving";
  const done = row.state === "verified" || row.state === "sent";
  const pct =
    row.size > 0n ? Math.min(100, (Number(row.transferred) / Number(row.size)) * 100) : 0;

  return (
    <li className={`slot relative flex items-center gap-3 px-3.5 py-2.5 ${row.state === "verified" ? "settled" : ""}`}>
      <StateDot state={row.state} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]" title={row.path ? `${row.path}/${row.name}` : row.name}>
          {row.path && <span className="text-ink-faint">{row.path}/</span>}
          {row.name}
        </p>
        {active && (
          <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-signal transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>

      <span className="tabular shrink-0 text-[12px] text-ink-faint">
        {active ? `${pct.toFixed(0)}%` : formatBytes(row.size)}
      </span>

      {onRemove && !active && !done && (
        <button
          type="button"
          onClick={() => onRemove(row.id)}
          className="shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:bg-ground-deep hover:text-ink"
          aria-label={`Remove ${row.name}`}
        >
          <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </li>
  );
}

function StateDot({ state }: { state: RowState }) {
  if (state === "verified" || state === "sent") {
    return (
      <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0 text-signal" aria-label="verified" role="img">
        <path
          d="M2.5 7.5l3 3 6-6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="failed" role="img">
        <path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  const active = state === "sending" || state === "receiving";
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "breathing bg-signal" : "bg-line-strong"}`}
    />
  );
}
