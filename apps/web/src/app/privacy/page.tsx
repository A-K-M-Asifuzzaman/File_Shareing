import type { Metadata } from "next";
import { Article, Points, Section } from "@/components/Prose";

export const metadata: Metadata = {
  title: "Privacy — Direct",
  description: "What we can and cannot see.",
};

export default function PrivacyPage() {
  return (
    <Article
      eyebrow="What we hold"
      title="Privacy"
      lede="The useful question is not what we promise not to do with your files. It is what we are able to do. The answer is nothing, because your files never reach us."
    >
      <Section heading="What never reaches our server">
        <Points
          items={[
            "The file itself — not a copy, not a cached piece, not a temporary one.",
            "The file name, its size, or its type.",
            "The key in your share link, which stays in the part of the URL browsers never send.",
          ]}
        />
        <p>
          File names travel directly between the two devices so the recipient knows what they
          are accepting. That exchange happens over the connection between you, not through us.
        </p>
      </Section>

      <Section heading="What the server does hold, briefly">
        <Points
          items={[
            "A random session ID, which is what identifies the transfer.",
            "The network details the two browsers exchange to find each other.",
            "Whether each side is currently connected.",
            "A one-way fingerprint of each access key — enough to check a key is valid, not enough to reconstruct it.",
          ]}
        />
        <p>
          All of this lives in memory and is deleted when the transfer ends or the session
          expires. There is no database. Nothing survives a server restart.
        </p>
      </Section>

      <Section heading="No accounts">
        <p>
          There is no sign-up, so there is no email address, no password and no profile. We do
          not set advertising or analytics cookies, and there is no third-party tracking on
          these pages.
        </p>
      </Section>

      <Section heading="What we can see">
        <p>
          Ordinary server logs record that a session was created and that peers connected,
          along with the session ID and timestamps. Access keys are never written to logs. Your
          IP address is visible to our server while you are connected to it, as it is to any
          website you visit.
        </p>
        <p>
          Your IP address is also visible to the person you are transferring with. That is
          inherent to a direct connection — the two devices have to know where to find each
          other. If that matters for who you are sending to, it is worth knowing before you
          start.
        </p>
      </Section>

      <Section heading="Links expire">
        <p>
          A link that nobody opens stops working after ten minutes. Once a transfer is under
          way the session stays alive while data moves, and is destroyed when it finishes. An
          expired link cannot be revived.
        </p>
      </Section>
    </Article>
  );
}
