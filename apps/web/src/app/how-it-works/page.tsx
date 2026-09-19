import type { Metadata } from "next";
import { Article, Points, Section } from "@/components/Prose";

export const metadata: Metadata = {
  title: "How it works — Direct",
  description: "What actually happens when you send a file.",
};

export default function HowItWorksPage() {
  return (
    <Article
      title="How it works"
      lede="Most file sharing uploads your file to a company's servers and gives the other person a link to download it. This does not do that. The file goes from your device to theirs."
    >
      <Section heading="The short version">
        <Points
          items={[
            "You pick a file. It stays on your disk.",
            "You get a link and send it to the other person however you like.",
            "They open it, and the two browsers find each other and connect.",
            "The file streams across that connection in small pieces.",
            "Both devices check the file matches when it finishes.",
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

      <Section heading="Why both tabs have to stay open">
        <p>
          The file is read from your disk as it sends. There is no copy sitting anywhere else,
          so if you close the tab, there is nothing left to send from. The same is true in
          reverse — the other person has to be there to receive it.
        </p>
        <p>
          This is the real trade-off compared to an upload service. You cannot send a file to
          someone who is asleep. In exchange, your file never sits on a stranger&rsquo;s hard
          drive.
        </p>
      </Section>

      <Section heading="Large files">
        <p>
          The limit is 100 GB per transfer. Neither side ever holds the whole file in memory: it
          is read in 64 KB pieces, sent, and written straight to disk on the other end. A 100 GB
          transfer uses about as much memory as a 100 MB one.
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
          the page tells you. It does not silently reroute your file through somewhere else.
        </p>
      </Section>
    </Article>
  );
}
