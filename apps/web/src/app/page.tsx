"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Field } from "@/components/Field";
import { Reveal } from "@/components/Reveal";
import { ShareLink } from "@/components/Link";
import {
  Endpoints,
  FileLine,
  Notice,
  ProgressReadout,
  type LinkPhase,
} from "@/components/Transfer";
import { FileSender, type SenderSnapshot } from "@/lib/transfer/sender";
import { MAX_TRANSFER_BYTES, formatBytes } from "@/lib/transfer/protocol";

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

  const active = snap?.state === "transferring" || snap?.state === "verifying";
  const live = Boolean(snap && snap.state !== "idle" && snap.state !== "failed");

  return (
    <>
      {/* The field reads the real transfer: it accelerates while bytes move
          and the corridor fills as progress does. */}
      <section className="relative isolate overflow-hidden border-b border-line">
        <div className="absolute inset-0 -z-10 bg-ground-deep" />
        <Field
          intensity={active ? 1 : live ? 0.45 : 0.12}
          progress={snap?.progress.fraction ?? 0}
          className="-z-10 opacity-90"
        />

        <div className="mx-auto w-full max-w-6xl px-5 pt-16 pb-20 sm:pt-24 sm:pb-28">
          {!file || !snap ? (
            <Hero dragging={dragging} setDragging={setDragging} onPick={(f) => void begin(f)} />
          ) : (
            <div className="mx-auto w-full max-w-xl">
              <SenderView snap={snap} onReset={reset} />
            </div>
          )}
        </div>
      </section>

      <Explainer />
    </>
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
    <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
      <div className="rise">
        <p className="eyebrow">Peer to peer · nothing stored</p>

        <h1 className="display mt-5 text-[40px] sm:text-[56px] lg:text-[64px]">
          Send a file straight
          <br />
          to someone else&rsquo;s
          <br />
          <span className="text-signal">device.</span>
        </h1>

        <p className="mt-6 max-w-md text-[16px] leading-relaxed text-ink-soft">
          Choose a file and you get a link. Open it on the other side and the bytes travel
          directly between the two browsers, encrypted, with no copy left on a server.
        </p>

        <dl className="mt-9 grid max-w-md grid-cols-3 gap-4">
          {[
            ["100 GB", "per transfer"],
            ["0 bytes", "kept by us"],
            ["SHA-256", "verified"],
          ].map(([big, small]) => (
            <div key={big} className="flex flex-col gap-1">
              <dt className="tabular text-[17px] text-ink">{big}</dt>
              <dd className="text-[12px] text-ink-faint">{small}</dd>
            </div>
          ))}
        </dl>
      </div>

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
        className={`glass rise relative rounded-2xl border p-8 shadow-[var(--shadow-lift)] transition-all duration-300 sm:p-10 ${
          dragging ? "scale-[1.015] border-signal" : "border-line"
        }`}
        style={{ animationDelay: "120ms" }}
      >
        <Endpoints phase={dragging ? "waiting" : "idle"} />

        <div className="mt-7 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="group relative w-full overflow-hidden rounded-xl bg-signal px-6 py-4 text-[15px] font-medium text-signal-ink transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99]"
          >
            Choose a file
          </button>

          <p className="text-[13px] text-ink-faint">
            or drop one here · up to {formatBytes(MAX_TRANSFER_BYTES)}
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) onPick(picked);
          }}
        />

        <p className="mt-7 border-t border-line pt-5 text-[12px] leading-relaxed text-ink-faint">
          Keep this tab open while it transfers — the file is read from this device as it sends,
          so there is nothing to delete afterwards.
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function SenderView({ snap, onReset }: { snap: SenderSnapshot; onReset: () => void }) {
  const finished =
    snap.state === "complete" || snap.state === "failed" || snap.state === "declined";

  return (
    <div className="glass rise rounded-2xl border border-line p-6 shadow-[var(--shadow-lift)] sm:p-8">
      <FileLine name={snap.fileName ?? ""} size={snap.fileSize ?? 0n} />

      <div className="mt-7">
        <Endpoints phase={PHASE[snap.state]} from="This device" to="Them" />
      </div>

      <div className="mt-7 flex flex-col gap-5">
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
            label={
              snap.state === "verifying"
                ? "Sent — waiting for them to finish saving…"
                : "Sending"
            }
          />
        )}

        {snap.state === "complete" && (
          <Notice tone="good">
            Sent and verified. The file reached their device intact and its checksum matches.
          </Notice>
        )}

        {snap.state === "declined" && <Notice>They declined the file.</Notice>}
        {snap.state === "failed" && <Notice tone="error">{snap.error}</Notice>}

        <div>
          <button
            type="button"
            onClick={onReset}
            className="rounded-xl border border-line px-5 py-3 text-[14px] transition-colors duration-200 hover:border-line-strong hover:bg-ground-deep"
          >
            {finished ? "Send another file" : "Cancel transfer"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const STEPS = [
  {
    n: "01",
    title: "Nothing uploads",
    body: "The file stays on your disk. We read it in small pieces only as it sends, so picking a 60 GB file is instant.",
  },
  {
    n: "02",
    title: "The server just introduces you",
    body: "It passes the two browsers enough to find each other on the network, then stops being involved. No file bytes pass through it.",
  },
  {
    n: "03",
    title: "Both ends check the result",
    body: "Sender and receiver hash the file as it moves. A mismatch fails loudly rather than handing over a file that will not open.",
  },
];

function Explainer() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:py-28">
      <Reveal>
        <p className="eyebrow">What actually happens</p>
        <h2 className="display mt-4 max-w-2xl text-[28px] sm:text-[36px]">
          Most file sharing uploads your file to a company&rsquo;s servers. This does not.
        </h2>
      </Reveal>

      <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <Reveal key={step.n} delay={i * 90}>
            <div className="h-full bg-panel p-7">
              <p className="tabular text-[12px] text-signal">{step.n}</p>
              <h3 className="mt-4 text-[17px] font-medium tracking-tight">{step.title}</h3>
              <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">{step.body}</p>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal delay={120}>
        <div className="mt-14 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-lg text-[14px] leading-relaxed text-ink-soft">
            The trade-off is real: both people have to be online at the same time. In exchange,
            your file never sits on a stranger&rsquo;s hard drive.
          </p>
          <Link
            href="/how-it-works"
            className="shrink-0 rounded-xl border border-line px-5 py-3 text-[14px] transition-colors hover:border-line-strong hover:bg-panel"
          >
            Read how it works
          </Link>
        </div>
      </Reveal>
    </section>
  );
}
