"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Reveals content on scroll, once.
 *
 * Renders visible and is hidden only after mount, so the page reads correctly
 * with no JavaScript and nothing is stranded invisible if the observer never
 * fires. The class is toggled on the node directly rather than through state:
 * this is a subscription to an external system, and re-rendering a subtree to
 * change one opacity is wasted work.
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    el.classList.add("reveal-pending");
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.classList.remove("reveal-pending");
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}
