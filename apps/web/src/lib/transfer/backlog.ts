/**
 * Tracks bytes taken off the wire but not yet written to disk, and decides
 * when to ask the sender to pause.
 *
 * Disks are routinely slower than the connection, and WebRTC stops nobody on
 * our behalf once a message has been handed to us. Unchecked, the difference
 * between network speed and disk speed accumulates in memory — the one thing
 * a 100 GB transfer cannot afford.
 *
 * Separated from the receiver so the thresholds can be tested without a
 * browser, a peer connection or a disk.
 */
export class Backlog {
  private bytes = 0;
  private paused = false;
  private readonly high: number;
  private readonly low: number;

  // Written out rather than as constructor parameter properties: the test
  // runner strips types without transforming, and does not support those.
  constructor(high: number, low: number) {
    this.high = high;
    this.low = low;
  }

  /** Record arrived bytes. Returns true when the sender should be paused. */
  arrived(size: number): boolean {
    this.bytes += size;
    if (!this.paused && this.bytes >= this.high) {
      this.paused = true;
      return true;
    }
    return false;
  }

  /**
   * Record bytes written. Returns true when the sender should be resumed.
   *
   * Callers must pass the size measured on arrival: hashing transfers the
   * buffer to a worker, which detaches it, and a detached ArrayBuffer reports
   * a length of zero. Measuring it here would leave the backlog permanently
   * full and the transfer wedged.
   */
  written(size: number): boolean {
    this.bytes -= size;
    if (this.paused && this.bytes <= this.low) {
      this.paused = false;
      return true;
    }
    return false;
  }

  get depth(): number {
    return this.bytes;
  }

  get isPaused(): boolean {
    return this.paused;
  }
}
