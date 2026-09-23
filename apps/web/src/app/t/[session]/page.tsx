"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BatchLine,
  Endpoints,
  FileQueue,
  ForegroundHint,
  Notice,
  Panel,
  PrimaryButton,
  ProgressReadout,
  QuietButton,
  Working,
  type LinkPhase,
  type QueueRow,
} from "@/components/Transfer";
import { Field } from "@/components/Field";
import { FileReceiver, type ReceiverSnapshot } from "@/lib/transfer/receiver";
import { countFiles, formatBytes } from "@/lib/transfer/protocol";
import { readTokenFromFragment } from "@/lib/transfer/signaling";
import { useTransferGuards } from "@/lib/useTransferGuards";
import { useClientValue } from "@/lib/useClientValue";
import { record } from "@/lib/ui/history";
import { notify } from "@/lib/ui/notify";

const PHASE: Record<ReceiverSnapshot["state"], LinkPhase> = {
  connecting: "waiting",
  waiting: "waiting",
  offered: "waiting",
  receiving: "live",
  verifying: "live",
  complete: "done",
  declined: "idle",
  senderGone: "error",
  expired: "error",
  failed: "error",
};

export default function ReceivePage({ params }: PageProps<"/t/[session]">) {
  const { session } = use(params);
  const [snap, setSnap] = useState<ReceiverSnapshot | null>(null);
  const receiverRef = useRef<FileReceiver | null>(null);

  // The capability lives in the fragment, which never reaches the server, so
  // it can only be read in the browser. undefined means "not yet known".
  const token = useClientValue(() => readTokenFromFragment(window.location.hash));
  const noToken = token === null;

  useEffect(() => {
    if (!token) return;

    const receiver = new FileReceiver(session, token, setSnap);
    receiverRef.current = receiver;
    void receiver.start();

    return () => receiver.cancel();
  }, [session, token]);

  const active = snap?.state === "receiving" || snap?.state === "verifying";
  const live = Boolean(snap && snap.state !== "declined");

  return (
    <div className="relative isolate min-h-[70vh] overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-ground-deep" />
      <Field
        intensity={active ? 1 : live ? 0.4 : 0.12}
        progress={snap?.progress.fraction ?? 0}
        className="-z-10 opacity-90"
      />
      <div className="mx-auto w-full max-w-xl px-5 py-16 sm:py-24">
        {noToken ? (
          <Panel>
            <h1 className="text-[20px] font-medium tracking-tight">This link is incomplete</h1>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
              The part of the link after the <span className="tabular">#</span> is missing. It
              carries the key to the transfer, and some chat apps trim it. Ask the sender to send
              the whole link again — or to show you the QR code, which always carries it.
            </p>
          </Panel>
        ) : !snap ? (
          <Panel>
            <Endpoints phase="waiting" from="Them" to="This device" />
            <div className="mt-6">
              <Working label="Opening the transfer…" />
            </div>
          </Panel>
        ) : (
          <ReceiverView
            snap={snap}
            onAccept={() => receiverRef.current?.accept()}
            onDecline={() => receiverRef.current?.decline()}
          />
        )}
      </div>
    </div>
  );
}

function ReceiverView({
  snap,
  onAccept,
  onDecline,
}: {
  snap: ReceiverSnapshot;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { manifest, capability } = snap;
  const moving = snap.state === "receiving" || snap.state === "verifying";
  useTransferGuards(moving);

  const finished =
    snap.state === "complete" ||
    snap.state === "failed" ||
    snap.state === "declined" ||
    snap.state === "senderGone";

  // One history entry per transfer, written the moment it settles.
  const logged = useRef(false);
  useEffect(() => {
    if (!finished || !manifest || logged.current) return;
    logged.current = true;

    record({
      direction: "received",
      label: manifest.files[0]?.name ?? "transfer",
      fileCount: manifest.files.length,
      bytes: manifest.totalBytes.toString(),
      outcome:
        snap.state === "complete" ? "complete" : snap.state === "declined" ? "declined" : "failed",
      seconds: snap.progress.elapsedSeconds || null,
    });

    if (snap.state === "complete") {
      notify("Transfer complete", `${countFiles(manifest.files.length)} saved and verified.`);
    }
  }, [finished, manifest, snap]);

  const rows: QueueRow[] = snap.files.map((f) => ({
    id: f.entry.fileId,
    name: f.entry.name,
    path: f.entry.path,
    size: f.entry.size,
    transferred: f.transferred,
    state: f.state,
  }));

  return (
    <Panel>
      {manifest ? (
        <BatchLine files={manifest.files} totalBytes={manifest.totalBytes} />
      ) : (
        <p className="text-[15px] text-ink-soft">Incoming transfer</p>
      )}

      <div className="mt-7">
        <Endpoints phase={PHASE[snap.state]} from="Them" to="This device" />
      </div>

      <div className="mt-7 flex flex-col gap-5">
        {(snap.state === "connecting" || snap.state === "waiting") && (
          <Working
            label="Connecting to the sender…"
            patience="Taking a while. The transfer service may be waking up, or the sender may have closed their tab."
          />
        )}

        {manifest?.note && snap.state === "offered" && (
          <blockquote className="rounded-xl border-l-2 border-signal bg-panel-soft py-3 pr-4 pl-4 text-[14px] leading-relaxed whitespace-pre-wrap text-ink-soft">
            {manifest.note}
          </blockquote>
        )}

        {snap.state === "offered" && manifest && (
          <>
            {capability?.message && (
              <Notice tone={capability.ok ? "warn" : "error"}>{capability.message}</Notice>
            )}

            {capability?.ok ? (
              <>
                <Notice>
                  {countFiles(manifest.files.length)} — {formatBytes(manifest.totalBytes)} — transfer
                  directly from their device while both tabs stay open. You will be asked{" "}
                  {manifest.files.length > 1 ? "for a folder to put them in" : "where to save it"}.
                </Notice>
                <div className="flex flex-wrap gap-2">
                  {/* Called straight from the click: the save and folder
                      dialogs only open inside a user gesture. */}
                  <PrimaryButton onClick={onAccept}>
                    {manifest.files.length > 1 ? "Accept and choose a folder" : "Accept and save"}
                  </PrimaryButton>
                  <QuietButton onClick={onDecline}>Decline</QuietButton>
                </div>
              </>
            ) : (
              <Link href="/compatibility" className="text-[13px] text-ink-soft underline">
                Which browsers can take a transfer this size?
              </Link>
            )}
          </>
        )}

        {moving && <ForegroundHint />}

        {moving && (
          <ProgressReadout
            progress={snap.progress}
            label={
              snap.state === "verifying"
                ? "Saving to disk and verifying…"
                : `Receiving ${snap.current >= 0 ? snap.files[snap.current]?.entry.name ?? "" : ""}`
            }
          />
        )}

        {(moving || snap.state === "complete") && snap.files.length > 1 && (
          <FileQueue rows={rows} />
        )}

        {snap.state === "complete" && (
          <Notice tone="good">
            Transfer complete. {countFiles(snap.files.length)} verified against the sender&rsquo;s
            checksums{snap.savedTo ? ` and saved to ${snap.savedTo}` : ""}.
          </Notice>
        )}

        {snap.state === "declined" && <Notice>You declined the transfer.</Notice>}

        {snap.state === "expired" && (
          <Notice tone="error">
            {snap.error ?? "This link has expired."} Links are short-lived and work once, so ask
            the sender for a fresh one.
          </Notice>
        )}

        {snap.state === "senderGone" && (
          <Notice tone="error">
            {snap.error} They need to reopen the page and send a new link.
          </Notice>
        )}

        {snap.state === "failed" && <Notice tone="error">{snap.error}</Notice>}
      </div>
    </Panel>
  );
}
