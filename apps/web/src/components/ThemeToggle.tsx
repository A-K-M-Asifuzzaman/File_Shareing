"use client";

import { useId } from "react";
import {
  ACCENTS,
  setAccent,
  setScheme,
  useAccent,
  useScheme,
  type Accent,
  type Scheme,
} from "@/lib/ui/theme";

const SCHEMES: { value: Scheme; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "system", label: "Match system", icon: <Auto /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
];

/**
 * Scheme and accent, behind one control.
 *
 * Two rows rather than one, because they answer different questions: how
 * bright the room is, and which colour the product spends. Putting eight
 * buttons in the header would have made a settings panel out of a nav bar, so
 * it opens as a popover — native, which means dismissal, Escape and focus
 * handling are the platform's job rather than this file's.
 */
export function ThemeToggle() {
  const id = useId();
  const scheme = useScheme();
  const accent = useAccent();

  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-label="Theme"
        title="Theme"
        className="flex items-center gap-2 rounded-lg border border-line bg-panel-soft px-2.5 py-2 text-ink-soft transition-colors duration-200 hover:border-line-strong hover:text-ink"
      >
        {SCHEMES.find((s) => s.value === scheme)?.icon}
        <span
          aria-hidden="true"
          data-accent={accent}
          className="swatch h-2.5 w-2.5 rounded-full ring-1 ring-line-strong/60"
        />
      </button>

      <div id={id} popover="auto" className="picker">
        <div className="w-[268px] rounded-2xl border border-line bg-panel p-4 shadow-[var(--shadow-lift)]">
          <fieldset>
            <legend className="eyebrow mb-2.5">Appearance</legend>
            <div className="flex gap-1 rounded-xl border border-line bg-panel-soft p-1">
              {SCHEMES.map((option) => {
                const active = scheme === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setScheme(option.value)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[12px] transition-colors duration-200 ${
                      active
                        ? "bg-ground text-ink shadow-[var(--shadow)]"
                        : "text-ink-faint hover:text-ink-soft"
                    }`}
                  >
                    {option.icon}
                    <span>{option.value === "system" ? "Auto" : option.label}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="mt-4">
            <legend className="eyebrow mb-2.5">Accent</legend>
            <div className="flex flex-col gap-0.5">
              {ACCENTS.map((option) => (
                <AccentRow
                  key={option.value}
                  option={option}
                  active={accent === option.value}
                />
              ))}
            </div>
          </fieldset>

          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
            Kept on this device. The accent is the only colour the interface
            spends, so changing it changes nothing else.
          </p>
        </div>
      </div>
    </>
  );
}

function AccentRow({
  option,
  active,
}: {
  option: { value: Accent; label: string; note: string };
  active: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => setAccent(option.value)}
      className={`flex items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-200 ${
        active ? "bg-ground-deep" : "hover:bg-ground-deep/60"
      }`}
    >
      <span
        aria-hidden="true"
        data-accent={option.value}
        className="swatch h-5 w-5 shrink-0 rounded-full ring-1 ring-line-strong/60"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-ink">{option.label}</span>
        <span className="block truncate text-[11px] text-ink-faint">{option.note}</span>
      </span>
      {active && <Tick />}
    </button>
  );
}

const ICON = "h-[15px] w-[15px] shrink-0";

function Sun() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path
        d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Moon() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z" strokeLinejoin="round" />
    </svg>
  );
}

function Auto() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5" strokeLinecap="round" />
    </svg>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0 text-signal" aria-hidden="true">
      <path
        d="M2.5 7.5l3 3 6-6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
