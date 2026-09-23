import type { MetadataRoute } from "next";

/**
 * Installable as an app.
 *
 * No service worker: this page is useless offline — it needs the signaling
 * service to introduce two peers — so a cache would only risk serving a stale
 * client against a moved protocol. The manifest is here for the install
 * prompt, the icon and the standalone window, which is all that helps.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Direct — peer-to-peer file transfer",
    short_name: "Direct",
    description:
      "Send files straight from your device to someone else's. Nothing is stored on a server.",
    start_url: "/",
    display: "standalone",
    background_color: "#08090b",
    theme_color: "#08090b",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
