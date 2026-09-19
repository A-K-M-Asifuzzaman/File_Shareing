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
      title="Compatibility"
      lede="Sending works almost anywhere. Receiving very large files does not, and the reason is worth understanding before you rely on it."
    >
      <Section heading="This browser">
        {disk === undefined ? (
          <Notice>Checking&hellip;</Notice>
        ) : disk ? (
          <Notice tone="good">
            This browser can write incoming files straight to disk, so it can receive files up
            to the full 100 GB limit.
          </Notice>
        ) : (
          <Notice>
            This browser cannot write incoming files directly to disk. It can still send files
            of any size, and receive files up to {formatBytes(MEMORY_FALLBACK_LIMIT)}.
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
          can receive files up to 100 GB.
        </p>
        <p>
          <strong className="font-medium text-ink">Firefox and Safari</strong> can send any
          size, and receive up to {formatBytes(MEMORY_FALLBACK_LIMIT)}. Above that the page
          declines the transfer instead of attempting it and crashing the tab.
        </p>
        <p>
          <strong className="font-medium text-ink">Mobile browsers</strong> can send and receive
          smaller files. Phones suspend background tabs aggressively, which will interrupt a
          long transfer, so they are not a good fit for large ones.
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
