"use client";

import { useMemo } from "react";
import QRCode from "qrcode";

/**
 * The share link as a QR code.
 *
 * The common case for this product is desktop → phone, and typing a URL with
 * a 64-character capability in its fragment is not a thing anyone will do.
 *
 * Drawn as one SVG path rather than an image so it inherits the theme, stays
 * crisp at any size, and costs no raster: `create` gives the module matrix and
 * the rest is a few rectangles.
 */
export function Qr({ value, size = 168 }: { value: string; size?: number }) {
  const path = useMemo(() => {
    try {
      // Medium correction: the code still scans with a thumb over a corner,
      // without the density that makes a long URL unreadable on a phone.
      const { modules } = QRCode.create(value, { errorCorrectionLevel: "M" });
      const n = modules.size;
      const parts: string[] = [];
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (modules.data[y * n + x]) parts.push(`M${x} ${y}h1v1h-1z`);
        }
      }
      return { d: parts.join(""), n };
    } catch {
      // A URL too long to encode is not worth failing the transfer over.
      return null;
    }
  }, [value]);

  if (!path) return null;

  return (
    <div
      className="rounded-xl border border-line bg-panel p-3"
      style={{ width: size + 24, height: size + 24 }}
    >
      <svg
        viewBox={`0 0 ${path.n} ${path.n}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        role="img"
        aria-label="QR code for the transfer link"
      >
        <path d={path.d} className="fill-ink" />
      </svg>
    </div>
  );
}
