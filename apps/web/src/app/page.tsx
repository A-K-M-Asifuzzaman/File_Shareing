"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ShareLink } from "@/components/Link";
import { Endpoints, FileLine, Notice, Panel, ProgressReadout, type LinkPhase } from "@/components/Transfer";
import { FileSender, type SenderSnapshot } from "@/lib/transfer/sender";
import { MAX_TRANSFER_BYTES, formatBytes } from "@/lib/transfer/protocol";

export default function SendPage() {
  const [file, setFile] = useState<File | null>(null);
  const [snap, setSnap] = useState<SenderSnapshot | null>(null);
  const [dragging, setDragging] = useState(false);
  const senderRef = useRef<FileSender | null>(null);

  // A transfer only exists while this tab is open; make that concrete by
  // tearing the session down when the page goes away.
  useEffect(() => () => senderRef.current?.cancel(), []);

  const begin = useCallback(async (picked: File) => {
    setFile(picked);
    const sender = new FileSender(picked, setSnap);
    senderRef.current = sender;
    await sender.start();
  }, []);

  function reset() {
    senderRef.current?.cancel();
    senderRef.current = null;
    setFile(null);
    setSnap(null);
  }

  if (!file || !snap) {
    return (
      <Hero
        dragging={dragging}
        setDragging={setDragging}
        onPick={(f) => void begin(f)}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-12 sm:py-16">
      <SenderView snap={snap} onReset={reset} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Hero({
  dragging,
  setDragging,
  onPick,
}: {
  dragging: boolean;
  setDragging: (v: boolean) => void;
  onPick: (f: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-14 sm:py-20">
      <h1 className="text-[32px] leading-[1.15] font-medium tracking-tight sm:text-[40px]">
        Send a file straight to
        <br />
        someone else&rsquo;s device.
      </h1>

      <ol className="mt-7 flex flex-col gap-2 text-[15px] leading-relaxed text-ink-soft">
        <li>Choose a file. Nothing uploads.</li>
        <li>Send them the link you get back.</li>
        <li>Keep this tab open while it transfers.</li>
      </ol>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const dropped = e.dataTransfer.files[0];
          if (dropped) onPick(dropped);
        }}
        className={`mt-9 rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragging ? "border-signal bg-signal-wash" : "border-line bg-panel"
        }`}
      >
        <Endpoints phase="idle" />

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-4 rounded-lg bg-signal px-5 py-3 text-[15px] font-medium text-signal-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        >
          Choose a file
        </button>
        <p className="mt-3 text-[13px] text-ink-faint">
          or drop one here &middot; up to {formatBytes(MAX_TRANSFER_BYTES)}
        </p>

        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) onPick(picked);
          }}
        />
      </div>

      <p className="mt-6 text-[13px] leading-relaxed text-ink-faint">
        The file goes from your device to theirs over an encrypted direct
        connection. It is never uploaded to a server, so there is nothing to
        delete afterwards and no copy left behind.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const PHASE: Record<SenderSnapshot["state"], LinkPhase> = {
  idle: "idle",
  creating: "idle",
  waiting: "waiting",
  connecting: "waiting",
  offering: "waiting",
  transferring: "live",
  verifying: "live",
  complete: "done",
  declined: "idle",
  failed: "error",
};

function SenderView({ snap, onReset }: { snap: SenderSnapshot; onReset: () => void }) {
  return (
    <Panel>
      <FileLine name={snap.fileName ?? ""} size={snap.fileSize ?? 0n} />

      <div className="mt-6">
        <Endpoints phase={PHASE[snap.state]} from="This device" to="Them" />
      </div>

      <div className="mt-6 flex flex-col gap-5">
        {snap.state === "creating" && <Notice>Creating a transfer session&hellip;</Notice>}

        {(snap.state === "waiting" || snap.state === "connecting" || snap.state === "offering") &&
          snap.shareUrl && (
            <>
              <ShareLink url={snap.shareUrl} />
              <Notice>
                {snap.state === "waiting"
                  ? "Waiting for them to open the link. Keep this tab open — the file is sent from this device."
                  : snap.state === "connecting"
                    ? "They opened the link. Making a direct connection…"
                    : "Connected. Waiting for them to accept the file."}
              </Notice>
            </>
          )}

        {(snap.state === "transferring" || snap.state === "verifying") && (
          <ProgressReadout
            progress={snap.progress}
            label={snap.state === "verifying" ? "Verifying…" : "Sending"}
          />
        )}

        {snap.state === "complete" && (
          <Notice tone="good">Sent and verified. The file reached their device intact.</Notice>
        )}

        {snap.state === "declined" && <Notice>They declined the file.</Notice>}

        {snap.state === "failed" && <Notice tone="error">{snap.error}</Notice>}

        <div>
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg border border-line px-4 py-2.5 text-[14px] transition-colors hover:bg-ground"
          >
            {snap.state === "complete" || snap.state === "failed" || snap.state === "declined"
              ? "Send another file"
              : "Cancel transfer"}
          </button>
        </div>
      </div>
    </Panel>
  );
}
