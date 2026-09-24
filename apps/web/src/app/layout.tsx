import type { Metadata } from "next";
import Link from "next/link";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import { GetTheApp } from "@/components/GetTheApp";
import { ThemeColor } from "@/components/ThemeColor";
import { ThemeToggle } from "@/components/ThemeToggle";
import { THEME_SCRIPT } from "@/lib/ui/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Headlines only. Bricolage's slightly narrow, slightly irregular shapes give
// the page a voice; Geist stays for anything you actually have to read at
// 13–16px, where character is a liability.
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: {
    default: "Direct — peer-to-peer file transfer",
    template: "%s — Direct",
  },
  description:
    "Send files straight from your device to someone else's. Up to 100 GB, folders included, SHA-256 verified, and nothing is stored on a server.",
  applicationName: "Direct",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Direct", statusBarStyle: "black-translucent" },
  openGraph: {
    title: "Direct — peer-to-peer file transfer",
    description:
      "Files go browser to browser over WebRTC. No upload, no bucket, no copy left behind.",
    type: "website",
  },
};

const NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/android", label: "Android" },
  { href: "/security", label: "Security" },
  { href: "/diagnostics", label: "Diagnostics" },
  { href: "/privacy", label: "Privacy" },
  { href: "/compatibility", label: "Compatibility" },
] as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bricolage.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Before first paint: otherwise the stored theme lands a frame late
            and a dark-mode user gets a white flash on every navigation. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <ThemeColor />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-panel focus:px-4 focus:py-2 focus:text-[14px]"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-50 border-b border-line/70 glass">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4">
            <Link href="/" className="group flex items-center gap-2.5" aria-label="Direct, home">
              <Mark />
              <span className="text-[15px] font-medium tracking-tight">Direct</span>
            </Link>

            <nav className="hidden items-center gap-1 text-[13px] lg:flex">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-3 py-2 text-ink-soft transition-colors duration-200 hover:bg-ground-deep hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="flex items-center gap-2">
              <Link
                href="/how-it-works"
                className="rounded-lg px-2 py-2 text-[13px] text-ink-soft transition-colors hover:text-ink lg:hidden"
              >
                How it works
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main id="main" className="flex-1">
          {children}
        </main>

        <GetTheApp />

        <footer className="border-t border-line">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <p className="text-[13px] text-ink-soft">
                Files move device to device. No copy is kept.
              </p>
              <p className="tabular text-[11px] text-ink-faint">
                Protocol v2 · 100 GB ceiling · folders and batches
              </p>
            </div>
            <nav className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] lg:hidden">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="text-ink-soft hover:text-ink">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}

/** Two endpoints and the path between them — the whole product in 22px. */
function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="shrink-0">
      <circle cx="4" cy="11" r="3" className="fill-ink" />
      <path
        d="M8 11h6"
        className="stroke-signal"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="2 3"
      />
      <circle cx="18" cy="11" r="3" className="fill-none stroke-ink" strokeWidth="2" />
    </svg>
  );
}
