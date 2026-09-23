import type { Metadata } from "next";
import { Article, Points, Section } from "@/components/Prose";

export const metadata: Metadata = {
  title: "Security — Direct",
  description: "How transfers are protected, and what this does not protect you from.",
};

export default function SecurityPage() {
  return (
    <Article
      eyebrow="Threat model"
      title="Security"
      lede="How a transfer is protected, and — more usefully — what it does not protect you from."
    >
      <Section heading="The connection is encrypted">
        <p>
          Transfers run over WebRTC, which encrypts every data channel with DTLS. This is not
          optional and cannot be turned off. Both sides verify each other&rsquo;s certificate
          fingerprint during the handshake, so a third party cannot quietly insert themselves
          between you.
        </p>
      </Section>

      <Section heading="Your link is the key">
        <p>
          Each transfer mints two 256-bit access keys from your browser&rsquo;s cryptographic
          random generator — one for the sender, one for the recipient. They are not
          interchangeable: the recipient&rsquo;s key cannot act as the sender and vice versa.
        </p>
        <p>
          The server stores only a SHA-256 fingerprint of each key and compares them in
          constant time, so a stolen server has nothing to hand out and a patient attacker
          cannot guess a key one byte at a time.
        </p>
        <p>
          The recipient&rsquo;s key sits after the <span className="tabular">#</span> in the
          share link. Browsers do not send that part of a URL to the server, so it stays out of
          our access logs, out of any proxy along the way, and out of referrer headers.
        </p>
      </Section>

      <Section heading="Anyone with the link can take the file">
        <p>
          This is the part worth being clear about. The link is the only credential. Whoever
          opens it first gets the file, whether or not they are the person you meant.
        </p>
        <p>
          So send it through a channel you trust. A link posted in a public channel or a group
          chat is a link anyone in that room can use.
        </p>
      </Section>

      <Section heading="The file is verified">
        <p>
          The sender hashes the file with SHA-256 as it reads, and the recipient hashes it as
          it writes. The two are compared when the transfer ends.
        </p>
        <p>
          A mismatch fails the transfer and discards the partial file. A file that arrives
          corrupted is never presented as complete — an honest failure is worth more than a
          quiet one, particularly at these sizes.
        </p>
      </Section>

      <Section heading="What the server enforces">
        <Points
          items={[
            "Exactly two participants per session — a third cannot join.",
            "Access keys are checked before any connection is established.",
            "Signaling messages are size-capped and must be well-formed.",
            "Session creation is rate-limited per address.",
            "Sessions expire on a timer and are deleted automatically.",
          ]}
        />
      </Section>

      <Section heading="What this does not protect you from">
        <Points
          items={[
            "A recipient you did not intend, if your link is shared or intercepted.",
            "Malware in a file you accept. Nothing here scans file contents — we cannot, we never see them.",
            "A compromised device on either end. Encryption in transit does not help if the disk it lands on is already someone else's.",
          ]}
        />
      </Section>
    </Article>
  );
}
