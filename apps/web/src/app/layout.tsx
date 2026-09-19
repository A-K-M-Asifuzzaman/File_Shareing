import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Direct — peer-to-peer file transfer",
  description:
    "Send a file straight from your device to someone else's. Nothing is stored on a server.",
};

const NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/security", label: "Security" },
  { href: "/privacy", label: "Privacy" },
  { href: "/compatibility", label: "Compatibility" },
] as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <header className="border-b border-line">
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-5">
            <Link href="/" className="group flex items-center gap-2.5">
              <Mark />
              <span className="text-[15px] font-medium tracking-tight">Direct</span>
            </Link>
            <nav className="flex items-center gap-1 text-[13px]">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-2.5 py-1.5 text-ink-soft transition-colors hover:bg-panel hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-line">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-5 py-6 text-[13px] text-ink-faint sm:flex-row sm:items-center sm:justify-between">
            <p>Files move device to device. No copy is kept.</p>
            <p className="tabular">Protocol v1</p>
          </div>
        </footer>
      </body>
    </html>
  );
}

/** Two endpoints and the path between them — the whole product in 20px. */
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
      <circle
        cx="18"
        cy="11"
        r="3"
        className="fill-none stroke-ink"
        strokeWidth="2"
      />
    </svg>
  );
}
