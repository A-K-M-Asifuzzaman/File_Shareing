export interface Progress {
  transferred: bigint;
  total: bigint;
  /** 0–1, or 0 before the total is known. */
  fraction: number;
  bytesPerSecond: number;
  /** Seconds remaining, or null while the rate is still meaningless. */
  etaSeconds: number | null;
}

const EMPTY: Progress = {
  transferred: 0n,
  total: 0n,
  fraction: 0,
  bytesPerSecond: 0,
  etaSeconds: null,
};

/**
 * Transfer rate and ETA.
 *
 * Rate is smoothed over a short trailing window rather than computed against
 * the whole transfer: an average since the start barely moves after the first
 * minute, so a stall would keep showing a healthy number. Over a 100 GB
 * transfer that difference is the whole value of the readout.
 */
export class ProgressMeter {
  private total = 0n;
  private transferred = 0n;
  private samples: { at: number; bytes: bigint }[] = [];

  private static readonly WINDOW_MS = 5_000;

  start(total: bigint): void {
    this.total = total;
    this.transferred = 0n;
    this.samples = [{ at: performance.now(), bytes: 0n }];
  }

  set(transferred: bigint): void {
    this.transferred = transferred;

    const now = performance.now();
    this.samples.push({ at: now, bytes: transferred });

    // Keep one sample older than the window so the span is always full-length.
    let drop = 0;
    while (drop + 1 < this.samples.length && now - this.samples[drop + 1]!.at > ProgressMeter.WINDOW_MS) {
      drop++;
    }
    if (drop > 0) this.samples.splice(0, drop);
  }

  snapshot(): Progress {
    if (this.total <= 0n) return EMPTY;

    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];

    let bytesPerSecond = 0;
    if (first && last && last.at > first.at) {
      bytesPerSecond = (Number(last.bytes - first.bytes) * 1000) / (last.at - first.at);
    }

    const remaining = Number(this.total - this.transferred);
    return {
      transferred: this.transferred,
      total: this.total,
      fraction: Number(this.transferred) / Number(this.total),
      bytesPerSecond,
      etaSeconds: bytesPerSecond > 0 && remaining > 0 ? remaining / bytesPerSecond : null,
    };
  }
}
