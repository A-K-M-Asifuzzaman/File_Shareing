export function Article({ title, lede, children }: { title: string; lede: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-16 sm:py-24">
      <h1 className="display text-[34px] sm:text-[44px]">
        {title}
      </h1>
      <p className="mt-5 text-[17px] leading-relaxed text-ink-soft">{lede}</p>
      <div className="mt-12 flex flex-col gap-10">{children}</div>
    </div>
  );
}

export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[17px] font-medium tracking-tight">{heading}</h2>
      <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-ink-soft">
        {children}
      </div>
    </section>
  );
}

export function Points({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5">
          <span aria-hidden="true" className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-signal" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
