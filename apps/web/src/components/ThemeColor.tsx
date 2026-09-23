"use client";

import { useEffect } from "react";

/**
 * Tint the browser's own chrome to match the page.
 *
 * On a phone the address bar sits directly above the page, and a dark page
 * under a white bar is the one place the theme visibly stops. Next's static
 * `themeColor` metadata can only key off the OS preference, which is wrong the
 * moment someone picks a scheme explicitly — so the tag is owned here instead.
 *
 * The colour is read back out of the live tokens rather than duplicated as
 * hex in JavaScript, which means it cannot drift from the stylesheet. Being
 * one frame late is invisible: the browser applies this asynchronously anyway.
 */
export function ThemeColor() {
  useEffect(() => {
    const root = document.documentElement;

    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    const tag = meta;

    const sync = () => {
      const ground = getComputedStyle(root).getPropertyValue("--ground").trim();
      if (ground) tag.content = ground;
    };
    sync();

    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", sync);
    const watch = new MutationObserver(sync);
    watch.observe(root, { attributeFilter: ["data-theme", "data-accent"] });

    return () => {
      scheme.removeEventListener("change", sync);
      watch.disconnect();
    };
  }, []);

  return null;
}
