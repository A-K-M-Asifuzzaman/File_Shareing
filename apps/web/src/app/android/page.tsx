import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "The Android app",
  description:
    "The same transfer engine as a native Android client, with the one thing a browser tab cannot do: a transfer that keeps running while the app is in the background.",
};

const REPO = "https://github.com/A-K-M-Asifuzzaman/File_Shareing";

/**
 * `releases/latest/download/<name>` resolves to whatever the newest release
 * holds, so these links do not go stale on every version.
 */
const DOWNLOAD = `${REPO}/releases/latest/download`;

const BUILDS = [
  { file: "app-arm64-v8a-release.apk", label: "arm64-v8a", note: "almost every phone since 2017" },
  { file: "app-armeabi-v7a-release.apk", label: "armeabi-v7a", note: "older 32-bit phones" },
  { file: "app-x86_64-release.apk", label: "x86_64", note: "emulators" },
];

/** Real screenshots, from a real transfer — not mockups. */
const SHOTS = [
  {
    src: "/android/offer.webp",
    alt: "The Android app showing an incoming transfer of one 101 MB file, with Accept and save, and Decline.",
    caption: "A tapped link opens here, not in a browser.",
  },
  {
    src: "/android/transfer.webp",
    alt: "A transfer in progress at 32.8 percent, showing 391 KB/s, time remaining, and a throughput graph.",
    caption: "Rate, remaining and throughput, while it moves.",
  },
  {
    src: "/android/background.webp",
    alt: "The Android notification shade showing Direct receiving a file at 10 percent, 9.7 MB of 101 MB, 290 KB/s.",
    caption: "Leave the app. It keeps going, and says so.",
  },
  {
    src: "/android/theme.webp",
    alt: "The appearance sheet with Light, Auto and Dark, and five accent colours: signal, ion, ember, violet and bone.",
    caption: "The same two theme axes as this site.",
  },
];

const ADDS = [
  {
    title: "It survives the background",
    body: "A foreground service holds the transfer open when you leave the app, with progress in the notification. A browser tab cannot promise that — leave it and the transfer dies with it.",
  },
  {
    title: "Links open the app",
    body: "A share link sent in a chat is claimed by the app rather than the browser, verified against this domain. The offer arrives on the phone straight from the tap.",
  },
  {
    title: "Files land in Downloads",
    body: "Bytes are written in 64 KB pieces as they arrive, never held whole in memory. Each file moves into the phone's Downloads only once its SHA-256 matches, so a half-received file never appears there under a name that suggests it is ready.",
  },
];

export default function AndroidPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:py-24">
      <header className="max-w-2xl">
        <p className="eyebrow">Android</p>
        <h1 className="display mt-4 text-[34px] sm:text-[44px]">
          The same transfer, as an app.
        </h1>
        <p className="mt-5 text-[17px] leading-relaxed text-ink-soft">
          A Flutter client on the same protocol and the same signaling service as this page, so a
          phone and a browser are two ends of one transfer rather than two products. What it adds
          is the thing a tab cannot have: the transfer keeps running when you leave.
        </p>
      </header>

      <div className="rule mt-12" />

      <div className="mt-12 grid grid-cols-2 gap-x-5 gap-y-10 sm:gap-x-8 lg:grid-cols-4">
        {SHOTS.map((shot) => (
          <figure key={shot.src} className="flex flex-col gap-4">
            <div className="overflow-hidden rounded-[26px] border border-line bg-panel p-1.5 shadow-[0_1px_0_0_var(--color-line)]">
              <Image
                src={shot.src}
                alt={shot.alt}
                width={540}
                height={750}
                className="h-auto w-full rounded-[20px]"
                sizes="(min-width: 1024px) 22vw, 44vw"
              />
            </div>
            <figcaption className="text-[13px] leading-relaxed text-ink-soft">
              {shot.caption}
            </figcaption>
          </figure>
        ))}
      </div>

      <section className="mt-20">
        <p className="eyebrow">What the app adds</p>
        <div className="mt-6 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
          {ADDS.map((item) => (
            <div key={item.title} className="h-full bg-panel p-7">
              <h2 className="text-[17px] font-medium tracking-tight">{item.title}</h2>
              <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-20 grid gap-12 lg:grid-cols-2">
        <div>
          <h2 className="text-[19px] font-medium tracking-tight">One protocol, two clients</h2>
          <div className="mt-4 flex flex-col gap-4 text-[15px] leading-relaxed text-ink-soft">
            <p>
              The wire contract lives in a pure Dart package with no Flutter dependency, so it is
              tested without a device — and its tests deliberately assert the same things as the
              TypeScript ones: manifest validation, filename sanitising, and the arithmetic that
              routes one chunk across a file boundary.
            </p>
            <p>
              That duplication is the point. If the two drift, a phone-to-browser transfer fails
              somewhere down in WebRTC, which is a painful place to find out. Pinning the contract
              on both sides means it fails in a test instead.
            </p>
          </div>
        </div>

        <div>
          <h2 className="text-[19px] font-medium tracking-tight">Getting it</h2>
          <div className="mt-4 flex flex-col gap-4 text-[15px] leading-relaxed text-ink-soft">
            <p>
              Android only, and not on a store: the APK comes straight from the releases page. Most
              phones want the first one.
            </p>

            <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line">
              {BUILDS.map((build) => (
                <a
                  key={build.file}
                  href={`${DOWNLOAD}/${build.file}`}
                  className="flex items-baseline justify-between gap-4 bg-panel px-5 py-4 transition-colors hover:bg-panel-soft"
                >
                  <span className="tabular text-[13.5px] text-ink">{build.label}</span>
                  <span className="text-[13px] text-ink-faint">{build.note}</span>
                </a>
              ))}
            </div>

            <p className="text-[13px] text-ink-faint">
              Android will ask before installing an APK from outside the Play Store, because it
              should. The build is reproducible from the source below if you would rather not take
              a binary on trust.
            </p>

            <p>
              An iOS client is the same Dart on the other side of a platform channel, but the
              background transfer is the reason this app exists and iOS does not grant it the same
              way, so it is not worth shipping until that part has an honest answer.
            </p>

            <div className="flex flex-wrap gap-2">
              <Link
                href={`${REPO}/releases`}
                className="w-fit rounded-xl border border-line px-5 py-3 text-[14px] text-ink transition-colors hover:border-line-strong hover:bg-panel"
              >
                All releases
              </Link>
              <Link
                href={REPO}
                className="w-fit rounded-xl border border-line px-5 py-3 text-[14px] text-ink transition-colors hover:border-line-strong hover:bg-panel"
              >
                The source
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
