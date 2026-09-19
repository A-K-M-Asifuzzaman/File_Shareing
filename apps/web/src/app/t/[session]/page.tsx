"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Endpoints,
  FileLine,
  Notice,
  Panel,
  ProgressReadout,
  type LinkPhase,
} from "@/components/Transfer";
import { FileReceiver, type ReceiverSnapshot } from "@/lib/transfer/receiver";
import { readTokenFromFragment } from "@/lib/transfer/signaling";
import { useClientValue } from "@/lib/useClientValue";

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

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-12 sm:py-16">
      {noToken ? (
        <Panel>
          <h1 className="text-[20px] font-medium tracking-tight">This link is incomplete</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
            The part of the link after the <span className="tabular">#</span> is missing. It
            carries the key to the transfer, and some chat apps trim it. Ask the sender to send
            the whole link again.
          </p>
        </Panel>
      ) : !snap ? (
        <Panel>
          <Endpoints phase="waiting" from="Them" to="This device" />
        </Panel>
      ) : (
        <ReceiverView snap={snap} onAccept={() => receiverRef.current?.accept()} onDecline={() => receiverRef.current?.decline()} />
      )}
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
  const { offer, capability } = snap;

  return (
    <Panel>
      {offer ? (
        <FileLine name={offer.name} size={offer.size} />
      ) : (
        <p className="text-[15px] text-ink-soft">Incoming transfer</p>
      )}

      <div className="mt-6">
        <Endpoints phase={PHASE[snap.state]} from="Them" to="This device" />
      </div>

      <div className="mt-6 flex flex-col gap-5">
        {(snap.state === "connecting" || snap.state === "waiting") && (
          <Notice>Connecting to the sender&hellip;</Notice>
        )}

        {snap.state === "offered" && offer && (
          <>
            {capability?.message && (
              <Notice tone={capability.ok ? "info" : "error"}>{capability.message}</Notice>
            )}

            {capability?.ok ? (
              <>
                <Notice>
                  The file transfers directly from their device while both tabs stay open. You
                  will be asked where to save it.
                </Notice>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    /* Called straight from the click: the save dialog only
                       opens inside a user gesture. */
                    onClick={onAccept}
                    className="rounded-lg bg-signal px-5 py-3 text-[15px] font-medium text-signal-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                  >
                    Accept and save
                  </button>
                  <button
                    type="button"
                    onClick={onDecline}
                    className="rounded-lg border border-line px-5 py-3 text-[15px] transition-colors hover:bg-ground"
                  >
                    Decline
                  </button>
                </div>
              </>
            ) : (
              <Link href="/compatibility" className="text-[13px] text-ink-soft underline">
                Which browsers can take a file this size?
              </Link>
            )}
          </>
        )}

        {(snap.state === "receiving" || snap.state === "verifying") && (
          <ProgressReadout
            progress={snap.progress}
            label={
              snap.state === "verifying" ? "Saving to disk and verifying…" : "Receiving"
            }
          />
        )}

        {snap.state === "complete" && (
          <Notice tone="good">
            Transfer complete. The file was verified against the sender&rsquo;s checksum and
            matches exactly.
          </Notice>
        )}

        {snap.state === "declined" && <Notice>You declined the file.</Notice>}

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
