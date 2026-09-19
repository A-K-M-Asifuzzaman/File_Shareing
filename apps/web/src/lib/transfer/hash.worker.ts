/**
 * Incremental SHA-256, off the main thread.
 *
 * WebCrypto's digest() is one-shot: it needs the whole input at once, which
 * for a 100 GB file is exactly what this architecture refuses to do. hash-wasm
 * gives a streaming hasher, and running it in a worker keeps the progress UI
 * from stuttering while it chews through the file.
 */

import { createSHA256, type IHasher } from "hash-wasm";

export type HashRequest =
  | { type: "init" }
  | { type: "update"; chunk: ArrayBuffer }
  | { type: "final" };

export type HashResponse =
  | { type: "ready" }
  | { type: "updated" }
  | { type: "digest"; hex: string }
  | { type: "error"; message: string };

let hasher: IHasher | null = null;

self.onmessage = async (ev: MessageEvent<HashRequest>) => {
  const post = (r: HashResponse) => (self as unknown as Worker).postMessage(r);

  try {
    switch (ev.data.type) {
      case "init":
        hasher = await createSHA256();
        hasher.init();
        post({ type: "ready" });
        break;

      case "update":
        if (!hasher) throw new Error("hasher not initialised");
        hasher.update(new Uint8Array(ev.data.chunk));
        post({ type: "updated" });
        break;

      case "final":
        if (!hasher) throw new Error("hasher not initialised");
        post({ type: "digest", hex: hasher.digest("hex") });
        hasher = null;
        break;
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
