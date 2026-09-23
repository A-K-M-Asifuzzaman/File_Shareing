"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  checkIce,
  checkSignaling,
  environmentChecks,
  type Check,
  type Verdict,
} from "@/lib/transfer/diagnostics";
import { signalingOrigin } from "@/lib/transfer/signaling";
import { PROTOCOL_VERSION } from "@/lib/transfer/protocol";

interface Probe {
  env: Check[];
  network: Check[];
  candidates: string[];
}

/** Everything the page measures, gathered in one pass. */
async function probe(): Promise<Probe> {
  // Independent probes; there is no reason to make one wait for the other.
  const [signaling, ice] = await Promise.all([checkSignaling(), checkIce()]);
  return {
    env: environmentChecks(),
    network: [signaling, ice.check],
    candidates: ice.types,
  };
}

/**
 * "It doesn't work" is the hardest bug report this product can get, because
 * the most common cause — a network that will not allow a direct path — is
 * invisible and is not our code. This page turns that into something the
 * person in front of it can read and act on.
 */
export default function DiagnosticsPage() {
  const [env, setEnv] = useState<Check[]>([]);
  const [network, setNetwork] = useState<Check[]>([]);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [running, setRunning] = useState(true);

  /**
   * The probes are the external system this component synchronises with, so
   * the results land in a callback rather than in the effect body — and the
   * guard drops a result that arrives after someone has navigated away.
   */
  const apply = useCallback((result: Probe) => {
    setEnv(result.env);
    setNetwork(result.network);
    setCandidates(result.candidates);
    setRunning(false);
  }, []);

  useEffect(() => {
    let alive = true;
    void probe().then((result) => {
      if (alive) apply(result);
    });
    return () => {
      alive = false;
    };
  }, [apply]);

  function again() {
    setRunning(true);
    setNetwork([]);
    setCandidates([]);
    void probe().then(apply);
  }

  const worst = [...env, ...network].reduce<Verdict>(
    (acc, c) => (c.verdict === "fail" ? "fail" : c.verdict === "warn" && acc !== "fail" ? "warn" : acc),
    "pass",
  );

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-16 sm:py-24">
      <h1 className="display text-[34px] sm:text-[44px]">Diagnostics</h1>
      <p className="mt-5 text-[17px] leading-relaxed text-ink-soft">
        What this browser and this network can actually do. Everything here runs locally and
        against the signaling service — no transfer is created and nobody else is involved.
      </p>

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={again}
          disabled={running}
          className="rounded-xl bg-signal px-5 py-3 text-[14px] font-medium text-signal-ink transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50"
        >
          {running ? "Testing…" : "Run again"}
        </button>
        {!running && env.length > 0 && <Summary verdict={worst} />}
      </div>

      <Group title="This network" checks={network} pending={running && network.length === 0} />

      {candidates.length > 0 && (
        <p className="tabular mt-3 text-[12px] text-ink-faint">
          Candidate types gathered: {candidates.join(", ")}
        </p>
      )}

      <Group title="This browser" checks={env} pending={env.length === 0} />

      <div className="mt-12 rounded-2xl border border-line bg-panel-soft p-5">
        <p className="eyebrow">Build</p>
        <dl className="tabular mt-3 grid gap-2 text-[12px] sm:grid-cols-2">
          <Fact label="Protocol" value={`v${PROTOCOL_VERSION}`} />
          <Fact label="Signaling" value={signalingOrigin()} />
        </dl>
      </div>

      <p className="mt-8 text-[14px] leading-relaxed text-ink-soft">
        A warning on the network path usually means the two devices need to be on the same Wi-Fi.{" "}
        <Link href="/how-it-works" className="underline underline-offset-4">
          How a connection is made
        </Link>
        .
      </p>
    </div>
  );
}

function Summary({ verdict }: { verdict: Verdict }) {
  const text = {
    pass: "Everything a transfer needs is available.",
    warn: "Workable, with the caveats below.",
    fail: "Something a transfer needs is missing.",
    pending: "",
  }[verdict];

  return (
    <p className={`text-[13px] ${verdict === "fail" ? "text-danger" : verdict === "warn" ? "text-warn" : "text-ink-soft"}`}>
      {text}
    </p>
  );
}

function Group({
  title,
  checks,
  pending,
}: {
  title: string;
  checks: Check[];
  pending: boolean;
}) {
  return (
    <section className="mt-10">
      <h2 className="eyebrow">{title}</h2>

      {pending ? (
        <div className="mt-4 rounded-2xl border border-line bg-panel p-5">
          <div className="indeterminate h-1 w-full rounded-full bg-line" />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
          {checks.map((check) => (
            <li key={check.id} className="flex gap-3.5 px-5 py-4">
              <Badge verdict={check.verdict} />
              <div className="min-w-0">
                <p className="text-[14px] font-medium tracking-tight">{check.label}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{check.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Badge({ verdict }: { verdict: Verdict }) {
  const tone = {
    pass: "bg-signal-wash text-signal",
    warn: "bg-warn-wash text-warn",
    fail: "bg-danger-wash text-danger",
    pending: "bg-panel-soft text-ink-faint",
  }[verdict];

  const glyph = { pass: "✓", warn: "!", fail: "✕", pending: "·" }[verdict];

  return (
    <span
      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${tone}`}
      role="img"
      aria-label={verdict}
    >
      {glyph}
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="min-w-0 truncate text-ink-soft">{value}</dd>
    </div>
  );
}
