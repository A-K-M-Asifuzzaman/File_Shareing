import type { HashRequest, HashResponse } from "./hash.worker";

/**
 * Main-thread handle on the hashing worker.
 *
 * Calls are serialised: the worker holds one hasher and updates must be
 * applied in file order, so overlapping them would produce a wrong digest for
 * a file that transferred perfectly. Awaiting each update also gives natural
 * backpressure on the read loop.
 */
export class StreamHasher {
  private worker: Worker;
  private pending: ((r: HashResponse) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.worker = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<HashResponse>) => {
      const resolve = this.pending;
      this.pending = null;
      resolve?.(ev.data);
    };
  }

  private request(msg: HashRequest, transfer: Transferable[] = []): Promise<HashResponse> {
    const run = async (): Promise<HashResponse> => {
      const reply = new Promise<HashResponse>((resolve) => {
        this.pending = resolve;
      });
      this.worker.postMessage(msg, transfer);
      const res = await reply;
      if (res.type === "error") throw new Error(`Hashing failed: ${res.message}`);
      return res;
    };

    // Chain so updates are applied strictly in order.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async init(): Promise<void> {
    await this.request({ type: "init" });
  }

  /**
   * The buffer is transferred, not copied — it is detached afterwards and
   * must not be read again on this side.
   */
  async update(chunk: ArrayBuffer): Promise<void> {
    await this.request({ type: "update", chunk }, [chunk]);
  }

  async final(): Promise<string> {
    const res = await this.request({ type: "final" });
    return res.type === "digest" ? res.hex : "";
  }

  destroy(): void {
    this.worker.terminate();
  }
}
