import type { Metadata } from "next";
import { Article, Points, Section } from "@/components/Prose";

export const metadata: Metadata = {
  title: "How it works — Direct",
  description: "What actually happens when you send files.",
};

export default function HowItWorksPage() {
  return (
    <Article
      eyebrow="The mechanism"
      title="How it works"
      lede="Most file sharing uploads your files to a company's servers and gives the other person a link to download them. This does not do that. The files go from your device to theirs."
    >
      <Section heading="The short version">
        <Points
          items={[
            "You pick files, or a whole folder. They stay on your disk.",
            "You get one link — or a QR code — and send it however you like.",
            "They open it, and the two browsers find each other and connect.",
            "The files stream across that connection in small pieces, one after another.",
            "Both devices check every file matches as it finishes.",
          ]}
        />
      </Section>

      <Section heading="What the server does">
        <p>
          A connection between two browsers has to start somewhere. Our server is that
          introduction: it passes the two sides enough information to find each other on the
          network, then stops being involved.
        </p>
        <p>
          It handles connection details and nothing else. No part of your file passes through
          it, which also means there is no upload step and no waiting for one to finish before
          the other person can start downloading.
        </p>
      </Section>

      <Section heading="Several files at once">
        <p>
          A transfer carries a batch: a handful of files, or a folder with its structure intact.
          The other side is told the whole list up front — names and sizes, nothing else — and
          decides once, for all of it.
        </p>
        <p>
          The files then stream back to back with nothing in between. There is no pause between
          one file and the next and no round trip to negotiate each one, which is what keeps a
          folder of two hundred small files from taking longer than the one big file beside it.
          Each file still gets its own checksum, so a failure names the file it happened to.
        </p>
      </Section>

      <Section heading="Why both tabs have to stay open">
        <p>
          The files are read from your disk as they send. There is no copy sitting anywhere
          else, so if you close the tab, there is nothing left to send from. The same is true in
          reverse — the other person has to be there to receive them.
        </p>
        <p>
          This is the real trade-off compared to an upload service. You cannot send a file to
          someone who is asleep. In exchange, your file never sits on a stranger&rsquo;s hard
          drive.
        </p>
      </Section>

      <Section heading="Large files">
        <p>
          The limit is 100 GB per transfer, counted across every file in it. Neither side ever
          holds a whole file in memory: bytes are read in 64 KB pieces, sent, and written
          straight to disk on the other end. A 100 GB transfer uses about as much memory as a
          100 MB one.
        </p>
        <p>
          Writing directly to disk needs a browser feature that not every browser has. If yours
          cannot do it, the page says so before you start rather than failing partway through.
        </p>
      </Section>

      <Section heading="When it will not connect">
        <p>
          Some networks — corporate firewalls, a few mobile carriers — will not allow two devices
          to talk to each other directly. When that happens the connection fails outright and
          the page tells you. It does not silently reroute your files through somewhere else.
        </p>
        <p>
          The diagnostics page tests this network without starting a transfer, and says which
          kinds of path it managed to find. That turns &ldquo;it will not connect&rdquo; into
          something specific enough to act on.
        </p>
      </Section>
    </Article>
  );
}
