import Link from "next/link";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * The reading layout for the four explanatory pages.
 *
 * These pages carry the argument the product is making — that nothing is
 * uploaded, that the link is the key, that the trade-off is real — so they
 * are treated as documents rather than as filler: a measure narrow enough to
 * read, numbered sections, and an index that tracks where you are.
 *
 * The index is derived from the sections themselves rather than maintained
 * beside them, because a hand-written list of headings is a list that goes
 * stale the first time someone renames one.
 */

const PAGES = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/security", label: "Security" },
  { href: "/privacy", label: "Privacy" },
  { href: "/compatibility", label: "Compatibility" },
] as const;

type SectionProps = { heading: string; children: ReactNode };

function headingsOf(children: ReactNode): string[] {
  return Children.toArray(children)
    .filter(
      (child): child is ReactElement<SectionProps> =>
        isValidElement(child) && child.type === Section,
    )
    .map((child) => child.props.heading);
}

/** A stable anchor for a heading, so the index can link into the page. */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function Article({
  title,
  lede,
  eyebrow = "Reference",
  children,
}: {
  title: string;
  lede: string;
  eyebrow?: string;
  children: ReactNode;
}) {
  const headings = headingsOf(children);

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:py-24">
      <header className="max-w-2xl">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="display mt-4 text-[34px] sm:text-[44px]">{title}</h1>
        <p className="mt-5 text-[17px] leading-relaxed text-ink-soft">{lede}</p>
      </header>

      <div className="rule mt-12" />

      <div className="mt-12 gap-16 lg:grid lg:grid-cols-[minmax(0,42rem)_1fr] lg:items-start">
        <div className="flex flex-col gap-12">{children}</div>

        {/* Hidden below lg: at that width it would be a second copy of the
            page above the page. */}
        <nav aria-label="On this page" className="sticky top-24 hidden lg:block">
          <p className="eyebrow">On this page</p>
          <ol className="mt-4 flex flex-col gap-2.5">
            {headings.map((heading, i) => (
              <li key={heading} className="flex gap-3">
                <span className="tabular pt-px text-[11px] text-ink-faint">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <a
                  href={`#${slug(heading)}`}
                  className="text-[13px] leading-snug text-ink-soft transition-colors hover:text-ink"
                >
                  {heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>

      <Onward />
    </div>
  );
}

export function Section({ heading, children }: SectionProps) {
  const id = slug(heading);

  return (
    <section id={id} className="scroll-mt-24">
      {/* The anchor is on the heading, not the section, so linking to it puts
          the heading at the top of the viewport rather than under the header. */}
      <h2 className="group flex items-baseline gap-3 text-[19px] font-medium tracking-tight">
        <a
          href={`#${id}`}
          aria-label={`Link to ${heading}`}
          className="tabular -ml-6 w-3 shrink-0 text-[13px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
        >
          #
        </a>
        <span>{heading}</span>
      </h2>
      <div className="mt-4 flex flex-col gap-4 text-[15px] leading-relaxed text-ink-soft">
        {children}
      </div>
    </section>
  );
}

export function Points({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-2.5 border-l border-line pl-5">
      {items.map((item) => (
        <li key={item} className="relative">
          <span
            aria-hidden="true"
            className="absolute top-[9px] -left-[23px] h-1.5 w-1.5 rounded-full bg-signal"
          />
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * A pull-quote for the one sentence on a page that is the actual point.
 *
 * Deliberately rationed: if every page had three, none of them would read as
 * the thing worth stopping on.
 */
export function Note({ children }: { children: ReactNode }) {
  return (
    <blockquote className="border-l-2 border-signal bg-panel-soft py-4 pr-5 pl-5 text-[15px] leading-relaxed text-ink">
      {children}
    </blockquote>
  );
}

/** Where to go next, so the four pages read as one document. */
function Onward() {
  return (
    <div className="mt-20 border-t border-line pt-8">
      <p className="eyebrow">Keep reading</p>
      <div className="mt-5 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {PAGES.map((page) => (
          <Link
            key={page.href}
            href={page.href}
            className="bg-panel px-5 py-4 text-[14px] text-ink-soft transition-colors hover:bg-panel-soft hover:text-ink"
          >
            {page.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
