"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Field } from "@/components/Field";
import { History } from "@/components/History";
import { Reveal } from "@/components/Reveal";
import { ShareLink } from "@/components/Link";
import { Qr } from "@/components/Qr";
import {
  BatchLine,
  Endpoints,
  FileQueue,
  ForegroundHint,
  Notice,
  PrimaryButton,
  ProgressReadout,
  QuietButton,
  Working,
  type LinkPhase,
  type QueueRow,
} from "@/components/Transfer";
import { FileSender, pickedFromInput, type PickedFile, type SenderSnapshot } from "@/lib/transfer/sender";
import { useClientValue } from "@/lib/useClientValue";
import { useTransferGuards } from "@/lib/useTransferGuards";
import {
  MAX_FILES_PER_TRANSFER,
  MAX_TRANSFER_BYTES,
  countFiles,
  formatBytes,
} from "@/lib/transfer/protocol";
import { warmUp } from "@/lib/transfer/signaling";
import { filesFromDataTransfer } from "@/lib/ui/dropped";
import { record } from "@/lib/ui/history";
import { askToNotify, notify } from "@/lib/ui/notify";

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
  /** Chosen but not yet sent. A batch is assembled before it is committed. */
  const [staged, setStaged] = useState<PickedFile[]>([]);
  const [note, setNote] = useState("");
  const [snap, setSnap] = useState<SenderSnapshot | null>(null);
  const senderRef = useRef<FileSender | null>(null);

  // A transfer only exists while this tab is open; make that concrete by
  // tearing the session down when the page goes away.
  useEffect(() => () => senderRef.current?.cancel(), []);

  // Start waking the signaling service now rather than when someone commits
  // to a file — the cold start then happens while they are still choosing.
  useEffect(() => warmUp(), []);

  const add = useCallback((incoming: PickedFile[]) => {
    if (incoming.length === 0) return;
    setStaged((prev) => {
      // Same file picked twice is a slip, not an instruction to send it twice.
      const seen = new Set(prev.map(key));
      return [...prev, ...incoming.filter((p) => !seen.has(key(p)))].slice(
        0,
        MAX_FILES_PER_TRANSFER,
      );
    });
  }, []);

  const begin = useCallback(
    async (picked: PickedFile[], text: string) => {
      const sender = new FileSender(picked, setSnap, text);
      senderRef.current = sender;
      await sender.start();
    },
    [],
  );

  function reset() {
    senderRef.current?.cancel();
    senderRef.current = null;
    setStaged([]);
    setNote("");
    setSnap(null);
  }

  const active = snap?.state === "transferring" || snap?.state === "verifying";
  const live = Boolean(snap && snap.state !== "idle" && snap.state !== "failed");

  return (
    <>
      <PageDrop onFiles={add} disabled={Boolean(snap)} />

      {/* One filled surface, and everything on it belongs to the transfer. The
          field reads the real thing: it accelerates while bytes move and the
          corridor fills as progress does. */}
      <section className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-5 sm:pt-8">
        <div className="relative isolate overflow-hidden rounded-[var(--radius-panel)] bg-signal">
          <Field
            intensity={active ? 1 : live ? 0.45 : 0.12}
            progress={snap?.progress.fraction ?? 0}
            className="-z-10 opacity-25 mix-blend-soft-light"
          />

          {/* A running transfer gets its own white card, like the drop zone it
              replaces: the readouts are ink on paper, not on the fill. */}
          <div className="px-6 py-14 sm:px-12 sm:py-20">
            {snap ? (
              <div className="mx-auto w-full max-w-xl rounded-[var(--radius-card)] bg-panel p-6 shadow-[var(--shadow-lift)] sm:p-8">
                <SenderView
                  snap={snap}
                  onReset={reset}
                  onPause={() => senderRef.current?.pause()}
                  onResume={() => senderRef.current?.resume()}
                />
              </div>
            ) : (
              <Hero
                staged={staged}
                note={note}
                setNote={setNote}
                onAdd={add}
                onRemove={(id) => setStaged((prev) => prev.filter((p) => key(p) !== id))}
                onClear={() => setStaged([])}
                onSend={() => void begin(staged, note)}
              />
            )}
          </div>
        </div>
      </section>

      {!snap && <History />}
      <Explainer />
    </>
  );
}

/** Stable identity for a picked file, for dedupe and for list keys. */
function key(p: PickedFile): string {
  return `${p.path}/${p.file.name}:${p.file.size}:${p.file.lastModified}`;
}

function rowsFor(staged: PickedFile[]): QueueRow[] {
  return staged.map((p) => ({
    id: key(p),
    name: p.file.name,
    path: p.path,
    size: BigInt(p.file.size),
    transferred: 0n,
    state: "queued" as const,
  }));
}

/* -------------------------------------------------------------------------- */
/* Choosing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Drag anywhere on the page, and paste.
 *
 * A drop target the size of one card is a thing to aim at; the window is not.
 * Paste matters just as much — a screenshot lives on the clipboard and nowhere
 * else until it is pasted somewhere, and making someone save it to disk first
 * is pure friction.
 */
function PageDrop({
  onFiles,
  disabled,
}: {
  onFiles: (files: PickedFile[]) => void;
  disabled: boolean;
}) {
  const [over, setOver] = useState(false);
  // Drag events fire for every child element crossed, so a plain
  // enter/leave pair flickers. Counting them is what makes it stable.
  const depth = useRef(0);

  useEffect(() => {
    if (disabled) return;

    const carriesFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current++;
      setOver(true);
    };
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const onLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      void filesFromDataTransfer(e.dataTransfer).then(onFiles);
    };
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never steal a paste aimed at a text field.
      if (target?.closest("input, textarea, [contenteditable]")) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) onFiles(pickedFromInput(files));
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [onFiles, disabled]);

  if (!over) return null;

  return (
    <div className="armed pointer-events-none fixed inset-0 z-[55] flex items-center justify-center bg-ground/70 backdrop-blur-sm">
      <p className="rounded-xl border border-signal bg-panel px-5 py-3 text-[15px] shadow-[var(--shadow-lift)]">
        Drop to add — files or whole folders
      </p>
    </div>
  );
}

function Hero({
  staged,
  note,
  setNote,
  onAdd,
  onRemove,
  onClear,
  onSend,
}: {
  staged: PickedFile[];
  note: string;
  setNote: (v: string) => void;
  onAdd: (files: PickedFile[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onSend: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const total = staged.reduce((sum, p) => sum + BigInt(p.file.size), 0n);
  const over = total > MAX_TRANSFER_BYTES;

  return (
    <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
      <div className="rise">
        <h1 className="display text-[40px] text-signal-ink sm:text-[54px] lg:text-[60px]">
          Send a file straight to someone else&rsquo;s device
        </h1>

        <p className="mt-6 max-w-md text-[17px] leading-relaxed text-signal-ink-soft">
          You get one link. They open it, and the bytes go from your device to theirs — encrypted,
          and with no copy left on a server along the way.
        </p>

        <dl className="mt-10 grid max-w-md grid-cols-3 gap-6 border-t border-signal-edge pt-6">
          {[
            ["100 GB", "in one transfer"],
            ["Nothing", "kept on a server"],
            ["Every file", "checked on arrival"],
          ].map(([big, small]) => (
            <div key={big} className="flex flex-col gap-1">
              <dt className="text-[16px] font-medium text-signal-ink">{big}</dt>
              <dd className="text-[12.5px] leading-snug text-signal-ink-soft">{small}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* The brightest object on the page is the one you are meant to use. */}
      <div
        className="rise relative rounded-[var(--radius-card)] bg-panel p-6 shadow-[var(--shadow-lift)] sm:p-8"
        style={{ animationDelay: "120ms" }}
      >
        {staged.length === 0 ? (
          <>
            <Endpoints phase="idle" />
            <p className="mt-7 text-center text-[19px] font-medium tracking-tight">
              Drop your files here
            </p>
            <div className="mt-5 flex flex-col items-center gap-3">
              <PickButtons fileInput={fileInput} folderInput={folderInput} />
              <p className="text-[13px] text-ink-faint">
                Anywhere on this page works. Up to {formatBytes(MAX_TRANSFER_BYTES)} at a time.
              </p>
            </div>
            <p className="mt-7 border-t border-line pt-5 text-[12.5px] leading-relaxed text-ink-faint">
              Keep this tab open while it sends. The files are read from this device as they go,
              so there is nothing to delete afterwards.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-4 border-b border-line pb-4">
              <p className="text-[15px] font-medium tracking-tight">
                {countFiles(staged.length)} ready
              </p>
              <p className="tabular text-[14px] text-ink-soft">{formatBytes(total)}</p>
            </div>

            <div className="mt-4">
              <FileQueue rows={rowsFor(staged)} onRemove={onRemove} />
            </div>

            <label className="mt-4 block">
              <span className="sr-only">A note to send with the files</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="Add a note for them (optional)"
                className="w-full resize-none rounded-xl border border-line bg-panel px-3.5 py-3 text-[13px] leading-relaxed placeholder:text-ink-faint focus-visible:border-signal"
              />
            </label>

            {over && (
              <div className="mt-4">
                <Notice tone="error">
                  That is {formatBytes(total)} in total, over the{" "}
                  {formatBytes(MAX_TRANSFER_BYTES)} ceiling. Remove something, or send it in two
                  goes.
                </Notice>
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <PrimaryButton onClick={onSend} disabled={over}>
                Create the link
              </PrimaryButton>
              <PickButtons fileInput={fileInput} folderInput={folderInput} compact />
              <button
                type="button"
                onClick={onClear}
                className="ml-auto text-[13px] text-ink-faint underline-offset-4 hover:text-ink-soft hover:underline"
              >
                Clear
              </button>
            </div>
          </>
        )}

        <input
          ref={fileInput}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) onAdd(pickedFromInput(e.target.files));
            e.target.value = ""; // so picking the same file again still fires
          }}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          // Not in React's typings; the attribute is what the browser reads.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) onAdd(pickedFromInput(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

function PickButtons({
  fileInput,
  folderInput,
  compact = false,
}: {
  fileInput: React.RefObject<HTMLInputElement | null>;
  folderInput: React.RefObject<HTMLInputElement | null>;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <>
        <QuietButton onClick={() => fileInput.current?.click()}>Add files</QuietButton>
        <QuietButton onClick={() => folderInput.current?.click()}>Add a folder</QuietButton>
      </>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row">
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        className="flex-1 rounded-full bg-signal px-6 py-4 text-[15px] font-medium text-signal-ink transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99]"
      >
        Choose files
      </button>
      <button
        type="button"
        onClick={() => folderInput.current?.click()}
        className="rounded-full border border-line px-6 py-4 text-[15px] transition-colors duration-200 hover:border-line-strong hover:bg-ground-deep"
      >
        A folder
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sending                                                                    */
/* -------------------------------------------------------------------------- */

function SenderView({
  snap,
  onReset,
  onPause,
  onResume,
}: {
  snap: SenderSnapshot;
  onReset: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const moving = snap.state === "transferring" || snap.state === "verifying";
  useTransferGuards(moving && !snap.paused);

  const finished =
    snap.state === "complete" || snap.state === "failed" || snap.state === "declined";

  // One history entry per transfer, written the moment it settles.
  const logged = useRef(false);
  useEffect(() => {
    if (!finished || logged.current) return;
    logged.current = true;

    const outcome =
      snap.state === "complete" ? "complete" : snap.state === "declined" ? "declined" : "failed";
    record({
      direction: "sent",
      label: snap.files[0]?.entry.name ?? "transfer",
      fileCount: snap.files.length,
      bytes: snap.totalBytes.toString(),
      outcome,
      seconds: snap.progress.elapsedSeconds || null,
    });

    if (snap.state === "complete") {
      notify("Transfer complete", `${countFiles(snap.files.length)} delivered and verified.`);
    } else if (snap.state === "failed") {
      notify("Transfer failed", snap.error ?? "The transfer did not finish.");
    }
  }, [finished, snap]);

  const rows: QueueRow[] = snap.files.map((f) => ({
    id: f.entry.fileId,
    name: f.entry.name,
    path: f.entry.path,
    size: f.entry.size,
    transferred: f.transferred,
    state: f.state,
  }));

  const sharing =
    (snap.state === "waiting" || snap.state === "connecting" || snap.state === "offering") &&
    Boolean(snap.shareUrl);

  return (
    <div className="glass rise rounded-2xl border border-line p-6 shadow-[var(--shadow-lift)] sm:p-8">
      <BatchLine files={snap.files.map((f) => f.entry)} totalBytes={snap.totalBytes} />

      <div className="mt-7">
        <Endpoints phase={PHASE[snap.state]} from="This device" to="Them" />
      </div>

      <div className="mt-7 flex flex-col gap-5">
        {snap.state === "creating" && (
          <Working
            label="Creating a transfer session…"
            patience="Taking longer than usual — the transfer service sleeps when unused and is waking up. This only happens on the first transfer after a quiet spell."
          />
        )}

        {sharing && snap.shareUrl && (
          <>
            <ShareLink url={snap.shareUrl} />
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-5">
              <Qr value={snap.shareUrl} />
              <p className="text-[13px] leading-relaxed text-ink-soft">
                Scan it to open the transfer on a phone. The code carries the whole link,
                including the key after the <span className="tabular">#</span>.
              </p>
            </div>

            {snap.state === "connecting" ? (
              <Working
                label="They opened the link. Making a direct connection…"
                patience="Still trying. Some networks block direct connections between devices — if it does not settle, one of you may need a different network."
              />
            ) : (
              <Notice>
                {snap.state === "waiting"
                  ? "Waiting for them to open the link. Keep this tab open — the files are sent from this device."
                  : `Connected. Waiting for them to accept ${countFiles(snap.files.length)}.`}
              </Notice>
            )}
          </>
        )}

        {moving && <ForegroundHint />}

        {moving && (
          <>
            <ProgressReadout
              progress={snap.progress}
              paused={snap.paused}
              label={
                snap.paused
                  ? "Paused — the connection is still open"
                  : snap.state === "verifying"
                    ? "Sent — waiting for them to finish saving…"
                    : `Sending ${snap.current >= 0 ? snap.files[snap.current]?.entry.name ?? "" : ""}`
              }
            />
            <NotifyOffer />
          </>
        )}

        {snap.files.length > 1 && <FileQueue rows={rows} />}

        {snap.state === "complete" && (
          <Notice tone="good">
            Sent and verified. {countFiles(snap.files.length)} reached their device intact, and
            every checksum matched.
          </Notice>
        )}

        {snap.state === "declined" && <Notice>They declined the transfer.</Notice>}
        {snap.state === "failed" && <Notice tone="error">{snap.error}</Notice>}

        <div className="flex flex-wrap gap-2">
          {moving && (
            <QuietButton onClick={snap.paused ? onResume : onPause}>
              {snap.paused ? "Resume" : "Pause"}
            </QuietButton>
          )}
          <button
            type="button"
            onClick={onReset}
            className="rounded-xl border border-line px-5 py-3 text-[14px] transition-colors duration-200 hover:border-line-strong hover:bg-ground-deep"
          >
            {finished ? "Send something else" : "Cancel transfer"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Offered once, mid-transfer, which is the only moment it makes sense. */
function NotifyOffer() {
  // Notification.permission does not exist while rendering on the server, and
  // useClientValue is how the rest of this app reads a browser-only fact
  // without a first-frame flash of the wrong thing.
  const offerable = useClientValue(
    () => typeof Notification !== "undefined" && Notification.permission === "default",
  );
  const [asked, setAsked] = useState(false);

  if (!offerable || asked) return null;

  return (
    <button
      type="button"
      onClick={() => void askToNotify().then(() => setAsked(true))}
      className="self-start rounded-xl border border-line bg-panel-soft px-4 py-3 text-left text-[13px] leading-relaxed text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
    >
      This can take a while. <span className="text-ink underline underline-offset-4">Notify me</span>{" "}
      when it finishes, so you can go and do something else.
    </button>
  );
}

/* -------------------------------------------------------------------------- */

const STEPS = [
  {
    n: "01",
    title: "Nothing uploads",
    body: "The files stay on your disk. We read them in small pieces only as they send, so picking a 60 GB folder is instant.",
  },
  {
    n: "02",
    title: "The server just introduces you",
    body: "It passes the two browsers enough to find each other on the network, then stops being involved. No file bytes pass through it.",
  },
  {
    n: "03",
    title: "Both ends check every file",
    body: "Sender and receiver hash each file as it moves. A mismatch fails loudly rather than handing over a file that will not open.",
  },
];

function Explainer() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:py-28">
      <Reveal>
        <p className="eyebrow">What actually happens</p>
        <h2 className="display mt-4 max-w-2xl text-[28px] sm:text-[36px]">
          Most file sharing uploads your files to a company&rsquo;s servers. This does not.
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
            your files never sit on a stranger&rsquo;s hard drive.
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
