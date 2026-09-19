/**
 * Run: npm test   (node's built-in runner, native TypeScript stripping)
 *
 * Covers the logic that is wrong silently: a filename from a stranger, the
 * int64 string boundary, and a rate readout that must not keep showing a
 * healthy number through a stall.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TRANSFER_BYTES,
  formatBytes,
  formatDuration,
  offerFromMessage,
  offerToMessage,
  parseByteCount,
  sanitizeFilename,
  type ControlMessage,
} from "../src/lib/transfer/protocol.ts";
import { ProgressMeter } from "../src/lib/transfer/progress.ts";
import { Backlog } from "../src/lib/transfer/backlog.ts";

test("byte counts survive the round trip at 100 GB", () => {
  const offer = {
    transferId: "t",
    fileId: "f",
    name: "big.iso",
    size: 100_000_000_000n,
    mimeType: "application/octet-stream",
    lastModified: 0,
    chunkSize: 65536,
  };
  const wire = offerToMessage(offer);
  assert.equal(typeof (wire as { size: string }).size, "string", "size must be a string on the wire");
  assert.equal(offerFromMessage(wire).size, offer.size);
});

test("a size past 2^53 does not lose precision", () => {
  // The reason byte counts are strings: this value is not representable as a
  // JS number, and a JSON number would silently round it.
  const huge = "9007199254740993"; // 2^53 + 1
  assert.equal(parseByteCount(huge, "size").toString(), huge);
  assert.notEqual(Number(huge).toString(), huge, "precondition: this rounds as a number");
});

test("byte counts must be decimal strings", () => {
  for (const bad of ["", "-1", "1.5", "0x10", "1e9", " 12", "12 ", "abc"]) {
    assert.throws(() => parseByteCount(bad, "size"), `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(parseByteCount("0", "size"), 0n);
});

test("filenames from a peer cannot escape the save directory", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("/absolute/path.txt"), "path.txt");
  assert.equal(sanitizeFilename("..\\..\\windows\\system32"), "system32");
  assert.equal(sanitizeFilename("....//....//x"), "x");

  // Whatever the input, nothing that could traverse may survive.
  for (const evil of ["../../a", "a/../../b", "\\\\server\\share\\c", "..", "../"]) {
    const clean = sanitizeFilename(evil);
    assert.ok(!clean.includes("/") && !clean.includes("\\"), `separator survived: ${clean}`);
    assert.notEqual(clean, "..");
    assert.ok(!clean.startsWith("."), `hidden file: ${clean}`);
  }
});

test("filenames survive being stripped to nothing", () => {
  for (const empty of ["", "   ", "...", null, undefined]) {
    assert.equal(sanitizeFilename(empty), "received-file");
  }
});

test("control characters are removed from filenames", () => {
  const nasty = `re${String.fromCharCode(0)}port${String.fromCharCode(13)}.pdf`;
  const clean = sanitizeFilename(nasty);
  assert.equal(clean, "report.pdf");
  assert.ok(![...clean].some((c) => (c.codePointAt(0) ?? 0) < 0x20));
});

test("ordinary filenames are left alone", () => {
  for (const name of ["ubuntu-24.04.iso", "Q3 report (final).pdf", "café-menu.png", "日本語.txt"]) {
    assert.equal(sanitizeFilename(name), name);
  }
});

test("an offer above the limit is refused", () => {
  const over: ControlMessage = {
    type: "FILE_OFFER",
    transferId: "t",
    fileId: "f",
    name: "too-big.bin",
    size: (MAX_TRANSFER_BYTES + 1n).toString(),
    mimeType: "",
    lastModified: 0,
    chunkSize: 65536,
  };
  assert.throws(() => offerFromMessage(over), /exceeds/);

  const atLimit = { ...over, size: MAX_TRANSFER_BYTES.toString() };
  assert.equal(offerFromMessage(atLimit).size, MAX_TRANSFER_BYTES);
});

test("an offer with an absurd chunk size is refused", () => {
  const base: ControlMessage = {
    type: "FILE_OFFER",
    transferId: "t",
    fileId: "f",
    name: "x.bin",
    size: "1024",
    mimeType: "",
    lastModified: 0,
    chunkSize: 65536,
  };
  for (const chunkSize of [0, 512, 8 * 1024 * 1024, -1, 1.5]) {
    assert.throws(() => offerFromMessage({ ...base, chunkSize }), /chunk size/);
  }
});

test("an empty or negative file is refused", () => {
  const base: ControlMessage = {
    type: "FILE_OFFER",
    transferId: "t",
    fileId: "f",
    name: "x.bin",
    size: "0",
    mimeType: "",
    lastModified: 0,
    chunkSize: 65536,
  };
  assert.throws(() => offerFromMessage(base), /positive/);
});

test("sizes display in decimal units, matching the stated limit", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1000), "1.0 KB");
  assert.equal(formatBytes(8_400_000_000n), "8.4 GB");
  assert.equal(formatBytes(MAX_TRANSFER_BYTES), "100 GB");
});

test("durations read sensibly across the ranges that matter", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(90), "1m 30s");
  assert.equal(formatDuration(3700), "1h 1m");
  assert.equal(formatDuration(Infinity), "—");
});

test("rate reflects a stall instead of the long-run average", () => {
  // A meter averaging over the whole transfer would still claim ~10 MB/s
  // after a stall. Over a 100 GB transfer that readout is the whole point.
  let now = 0;
  const original = performance.now;
  (performance as { now: () => number }).now = () => now;

  try {
    const meter = new ProgressMeter();
    meter.start(1_000_000_000n);

    // 10 seconds at 10 MB/s.
    for (let i = 1; i <= 10; i++) {
      now = i * 1000;
      meter.set(BigInt(i * 10_000_000));
    }
    const moving = meter.snapshot();
    assert.ok(moving.bytesPerSecond > 9_000_000, `rate was ${moving.bytesPerSecond}`);
    assert.ok(moving.etaSeconds !== null && moving.etaSeconds > 0);

    // Now it stalls: time advances past the window, bytes do not.
    for (let i = 11; i <= 20; i++) {
      now = i * 1000;
      meter.set(100_000_000n);
    }
    const stalled = meter.snapshot();
    assert.equal(stalled.bytesPerSecond, 0, "a stalled transfer must report zero rate");
    assert.equal(stalled.etaSeconds, null, "a stalled transfer has no honest ETA");
  } finally {
    (performance as { now: () => number }).now = original;
  }
});

test("progress fraction is exact at the boundaries", () => {
  const meter = new ProgressMeter();
  meter.start(100n);
  assert.equal(meter.snapshot().fraction, 0);
  meter.set(100n);
  assert.equal(meter.snapshot().fraction, 1);
});

/* -------------------------------------------------------------------------- */
/* Receiver backpressure                                                      */
/* -------------------------------------------------------------------------- */

test("backlog pauses past the high mark and resumes under the low mark", () => {
  const b = new Backlog(8_000_000, 2_000_000);

  // 200 chunks of 64 KB is 13.1 MB, comfortably past the 8 MB high mark.
  let paused = false;
  let chunks = 0;
  for (let i = 0; i < 200; i++) {
    paused ||= b.arrived(65_536);
    chunks++;
    if (paused) break;
  }
  assert.ok(paused, "should have paused once the backlog passed 8 MB");
  assert.ok(chunks * 65_536 >= 8_000_000, "paused no earlier than the high mark");
  assert.ok(b.isPaused);

  // Draining back under the low mark resumes exactly once.
  let resumes = 0;
  for (let i = 0; i < chunks; i++) if (b.written(65_536)) resumes++;
  assert.equal(resumes, 1, "resume must fire once, not per chunk");
  assert.equal(b.depth, 0);
  assert.equal(b.isPaused, false);
});

test("backlog does not pause twice for one episode", () => {
  const b = new Backlog(1000, 200);
  assert.equal(b.arrived(1000), true, "first crossing pauses");
  assert.equal(b.arrived(1000), false, "already paused, no second PAUSE");
  assert.equal(b.written(1000), false, "still above the low mark");
  assert.equal(b.written(1000), true, "back under the low mark, resume");
});

test("backlog measured with a detached buffer's length would wedge forever", () => {
  // The bug this guards: hashing transfers the chunk to a worker, detaching
  // it, after which byteLength reads 0. Decrementing by that never drains the
  // backlog, so RESUME never fires and the transfer stalls at the high mark.
  const b = new Backlog(1000, 200);
  b.arrived(500);
  assert.equal(b.arrived(500), true, "paused at the high mark");

  for (let i = 0; i < 50; i++) b.written(0); // what a detached buffer reports
  assert.equal(b.isPaused, true, "still stuck — this is the failure mode");
  assert.equal(b.depth, 1000);

  // Passing the size captured on arrival is what actually frees it.
  b.written(500);
  assert.equal(b.written(500), true, "resumes once real sizes are used");
});
