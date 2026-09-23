"use client";

/**
 * Throughput over the last half-minute.
 *
 * A single rate number cannot tell a steady 40 MB/s from one that has been
 * sawtoothing between 5 and 80 — and on a long transfer that difference is
 * what tells someone whether the network is the problem. The line is scaled to
 * its own peak, so it reads as shape rather than as a second, worse, readout
 * of the number already shown above it.
 */
export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  if (values.length < 3) {
    return <div className={`h-9 ${className}`} aria-hidden="true" />;
  }

  const peak = Math.max(...values, 1);
  const w = 100;
  const h = 32;
  const step = w / (values.length - 1);

  const points = values.map((v, i) => [i * step, h - (v / peak) * (h - 2) - 1] as const);
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join("");
  const area = `${line}L${w} ${h}L0 ${h}Z`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={`h-9 w-full ${className}`}
      aria-hidden="true"
    >
      <path d={area} className="fill-signal" opacity="0.14" />
      <path
        d={line}
        className="stroke-signal"
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
