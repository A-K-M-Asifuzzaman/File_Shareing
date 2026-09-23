"use client";

import { Article, Section } from "@/components/Prose";
import { Notice } from "@/components/Transfer";
import { canStreamToDisk } from "@/lib/transfer/sink";
import { MEMORY_FALLBACK_LIMIT, formatBytes } from "@/lib/transfer/protocol";
import { useClientValue } from "@/lib/useClientValue";

export default function CompatibilityPage() {
  // Feature-detected in the browser: the server has no idea what this one can do.
  const disk = useClientValue(canStreamToDisk);

  return (
    <Article
      eyebrow="Where it runs"
      title="Compatibility"
      lede="Sending works almost anywhere. Receiving very large files does not, and the reason is worth understanding before you rely on it."
    >
      <Section heading="This browser">
        {disk === undefined ? (
          <Notice>Checking&hellip;</Notice>
        ) : disk ? (
          <Notice tone="good">
            This browser can write incoming files straight to disk, so it can receive transfers
            up to the full 100 GB limit, folders included.
          </Notice>
        ) : (
          <Notice>
            This browser cannot write incoming files directly to disk. It can still send any
            size, and receive transfers up to {formatBytes(MEMORY_FALLBACK_LIMIT)} in total.
          </Notice>
        )}
      </Section>

      <Section heading="Why receiving is the harder half">
        <p>
          Sending is straightforward: the file is already on your disk, and we read it in small
          pieces as it goes out. Any modern browser can do that at any size.
        </p>
        <p>
          Receiving needs somewhere to put the bytes as they arrive. The traditional approach —
          collect the whole file in memory, then hand it over — works fine for a photo and
          falls apart at 40 GB. Writing each piece to disk as it arrives requires the File
          System Access API, which Chromium-based browsers have and others currently do not.
        </p>
      </Section>

      <Section heading="Where it stands today">
        <p>
          <strong className="font-medium text-ink">
            Chrome, Edge, Opera and other Chromium browsers on desktop
          </strong>{" "}
          can receive transfers up to 100 GB, and can be handed a folder to put a whole batch
          into with one dialog.
        </p>
        <p>
          <strong className="font-medium text-ink">Firefox and Safari</strong> can send any
          size, and receive up to {formatBytes(MEMORY_FALLBACK_LIMIT)} in total. Above that the
          page declines the transfer instead of attempting it and crashing the tab. A multi-file
          transfer arrives as separate downloads rather than into a folder you choose.
        </p>
        <p>
          <strong className="font-medium text-ink">Mobile browsers</strong> can send and receive
          smaller files. Phones suspend background tabs aggressively, which will interrupt a
          long transfer, so they are not a good fit for large ones.
        </p>
      </Section>

      <Section heading="Leaving the browser pauses it">
        <p>
          On a phone, switching to another app freezes the page, and the transfer stops until
          you come back. It picks up where it left off rather than failing, but it makes no
          progress while you are away. Leave the tab in front for the whole transfer.
        </p>
        <p>
          This is not something we can code around. Mobile browsers suspend background pages
          deliberately, and there is no web API that exempts a transfer from it — a background
          worker does not survive it either. While a transfer is running we hold the screen
          awake, so the display switching off will not interrupt it.
        </p>
        <p>
          On desktop it is less strict: another tab in front, or the window minimised, is fine.
          The machine going to sleep is not.
        </p>
        <p>
          Running through a backgrounded app needs a native application rather than a web page,
          which is what the mobile client is for.
        </p>
      </Section>

      <Section heading="Networks matter too">
        <p>
          A direct connection has to get through whatever sits between the two devices. Home
          and most office networks are fine. Strict corporate firewalls and some mobile
          carriers block peer-to-peer traffic entirely, and no browser choice will work around
          that.
        </p>
        <p>
          When it cannot connect, the page says so rather than hanging. Trying from a different
          network is usually the fastest fix.
        </p>
      </Section>
    </Article>
  );
}
