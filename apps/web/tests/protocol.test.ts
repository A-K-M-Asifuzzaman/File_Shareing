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
  MAX_FILES_PER_TRANSFER,
  MAX_TRANSFER_BYTES,
  formatBytes,
  formatDuration,
  manifestFromMessage,
  manifestToMessage,
  parseByteCount,
  sanitizeFilename,
  sanitizeNote,
  sanitizePath,
  type ControlMessage,
  type Manifest,
  type ManifestEntry,
} from "../src/lib/transfer/protocol.ts";
import { ProgressMeter } from "../src/lib/transfer/progress.ts";
import { Backlog } from "../src/lib/transfer/backlog.ts";
import { BatchCursor } from "../src/lib/transfer/cursor.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    fileId: "f",
    name: "big.iso",
    path: "",
    size: 1024n,
    mimeType: "application/octet-stream",
    lastModified: 0,
    ...over,
  };
}

function manifest(files: ManifestEntry[], over: Partial<Manifest> = {}): Manifest {
  return {
    transferId: "t",
    chunkSize: 65536,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0n),
    files,
    note: "",
    ...over,
  };
}

test("byte counts survive the round trip at 100 GB", () => {
  const m = manifest([entry({ size: 100_000_000_000n })]);
  const wire = manifestToMessage(m);

  const files = (wire as { files: { size: unknown }[] }).files;
  assert.equal(typeof files[0]!.size, "string", "size must be a string on the wire");
  assert.equal(typeof (wire as { totalBytes: unknown }).totalBytes, "string");
  assert.equal(manifestFromMessage(wire).files[0]!.size, 100_000_000_000n);
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

test("relative paths from a peer cannot climb out of the chosen folder", () => {
  assert.equal(sanitizePath("photos/2024"), "photos/2024");
  assert.equal(sanitizePath("photos\\2024"), "photos/2024");
  assert.equal(sanitizePath(""), "");

  // Every traversal attempt must collapse toward the chosen directory.
  for (const evil of ["../..", "a/../../b", "/etc", "C:\\Windows", "\\\\server\\share", "..", "./.."]) {
    const clean = sanitizePath(evil);
    assert.ok(!clean.split("/").includes(".."), `traversal survived: ${clean}`);
    assert.ok(!clean.startsWith("/"), `absolute path survived: ${clean}`);
    assert.ok(
      !clean.split("/").some((seg) => seg.startsWith(".")),
      `hidden segment survived: ${clean}`,
    );
  }

  // "a/../../b" keeps its real segments and drops the traversal ones, so it
  // stays inside the folder rather than becoming a different file's path.
  assert.equal(sanitizePath("a/../../b"), "a/b");
});

test("a path cannot be nested absurdly deep", () => {
  const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join("/");
  assert.equal(sanitizePath(deep).split("/").length, 16);
});

test("a note from a peer keeps its line breaks and loses its control codes", () => {
  assert.equal(sanitizeNote("hi\nthere"), "hi\nthere");
  assert.equal(sanitizeNote(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c`), "abc");
  assert.equal(sanitizeNote(null), "");
  assert.equal(sanitizeNote("x".repeat(5000)).length, 2000);
});

test("a manifest above the limit is refused", () => {
  const over = manifestToMessage(manifest([entry({ size: MAX_TRANSFER_BYTES + 1n })]));
  assert.throws(() => manifestFromMessage(over), /limit/);

  const atLimit = manifestToMessage(manifest([entry({ size: MAX_TRANSFER_BYTES })]));
  assert.equal(manifestFromMessage(atLimit).totalBytes, MAX_TRANSFER_BYTES);
});

test("the limit applies to the batch, not to each file", () => {
  // Two files that each pass on their own but together do not.
  const half = MAX_TRANSFER_BYTES / 2n + 1n;
  const wire = manifestToMessage(
    manifest([entry({ fileId: "a", size: half }), entry({ fileId: "b", size: half })]),
  );
  assert.throws(() => manifestFromMessage(wire), /limit/);
});

test("a manifest whose total disagrees with its files is refused", () => {
  // A sender that understates the total would get the receiver to allocate
  // and account for less than it is about to be sent.
  const wire = manifestToMessage(manifest([entry({ size: 1000n })])) as Extract<
    ControlMessage,
    { type: "MANIFEST" }
  >;
  wire.totalBytes = "10";
  assert.throws(() => manifestFromMessage(wire), /total/);
});

test("a manifest with an absurd chunk size is refused", () => {
  for (const chunkSize of [0, 512, 8 * 1024 * 1024, -1, 1.5]) {
    const wire = manifestToMessage(manifest([entry()], { chunkSize }));
    assert.throws(() => manifestFromMessage(wire), /chunk size/);
  }
});

test("an empty file list, an empty file, and too many files are all refused", () => {
  assert.throws(() => manifestFromMessage(manifestToMessage(manifest([]))), /no files/);
  assert.throws(() => manifestFromMessage(manifestToMessage(manifest([entry({ size: 0n })]))), /positive/);

  const tooMany = Array.from({ length: MAX_FILES_PER_TRANSFER + 1 }, (_, i) =>
    entry({ fileId: `f${i}`, size: 1n }),
  );
  assert.throws(() => manifestFromMessage(manifestToMessage(manifest(tooMany))), /at most/);
});

test("names and paths in a manifest are sanitized on arrival", () => {
  const wire = manifestToMessage(
    manifest([entry({ name: "../../etc/passwd", path: "../../root", size: 10n })]),
  );
  // Rewrite the wire fields directly: a hostile peer does not use our builder.
  const hostile = wire as Extract<ControlMessage, { type: "MANIFEST" }>;
  hostile.files[0]!.name = "../../etc/passwd";
  hostile.files[0]!.path = "../../root";

  const parsed = manifestFromMessage(hostile);
  assert.equal(parsed.files[0]!.name, "passwd");
  assert.equal(parsed.files[0]!.path, "root");
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

/* -------------------------------------------------------------------------- */
/* Batch routing                                                              */
/* -------------------------------------------------------------------------- */

/** Rebuild what each file received, so a mis-split is visible as wrong bytes. */
function drain(sizes: bigint[], chunks: number[]): { written: number[]; overflow: number } {
  const cursor = new BatchCursor(sizes);
  const written = sizes.map(() => 0);
  let overflow = 0;

  for (const length of chunks) {
    const split = cursor.split(length);
    overflow += split.overflow;
    let covered = 0;
    for (const piece of split.pieces) {
      assert.equal(piece.offset, covered, "pieces must tile the chunk with no gap or overlap");
      covered += piece.length;
      written[piece.index]! += piece.length;
    }
    assert.equal(covered + split.overflow, length, "every wire byte must be accounted for");
  }
  return { written, overflow };
}

test("a single file takes whole chunks, as v1 did", () => {
  const { written, overflow } = drain([200_000n], [65536, 65536, 65536, 3392]);
  assert.deepEqual(written, [200_000]);
  assert.equal(overflow, 0);
});

test("a chunk straddling a file boundary is split between the two files", () => {
  // 100 bytes then 100 bytes, delivered as one 200-byte chunk.
  const cursor = new BatchCursor([100n, 100n]);
  const { pieces, overflow } = cursor.split(200);

  assert.equal(overflow, 0);
  assert.deepEqual(pieces, [
    { index: 0, offset: 0, length: 100, endsFile: true },
    { index: 1, offset: 100, length: 100, endsFile: true },
  ]);
  assert.equal(cursor.finished, true);
});

test("a chunk landing exactly on a boundary ends the file and starts no other", () => {
  const cursor = new BatchCursor([100n, 100n]);
  const { pieces } = cursor.split(100);
  assert.deepEqual(pieces, [{ index: 0, offset: 0, length: 100, endsFile: true }]);
  assert.equal(cursor.fileIndex, 1, "cursor has moved on");
  assert.equal(cursor.receivedInFile, 0n, "and the next file starts empty");
});

test("many small files inside one chunk each get their own bytes", () => {
  const sizes = Array.from({ length: 10 }, () => 10n);
  const { written, overflow } = drain(sizes, [100]);
  assert.deepEqual(written, Array.from({ length: 10 }, () => 10));
  assert.equal(overflow, 0);
});

test("uneven chunks across uneven files still reassemble exactly", () => {
  const sizes = [7n, 1n, 64_000n, 3n, 128_001n];
  const total = Number(sizes.reduce((a, b) => a + b, 0n));

  // Deliver it in 64 KB chunks with a ragged tail, as SCTP actually would.
  const chunks: number[] = [];
  for (let left = total; left > 0; left -= 65536) chunks.push(Math.min(65536, left));

  const { written, overflow } = drain(sizes, chunks);
  assert.deepEqual(written, sizes.map(Number));
  assert.equal(overflow, 0);
});

test("bytes past the end of the last file are reported as overflow, not written", () => {
  // The failure this guards: a hostile sender streaming past its declared
  // sizes, which without this check writes unbounded data to the user's disk.
  const cursor = new BatchCursor([100n]);
  const { pieces, overflow } = cursor.split(150);

  assert.deepEqual(pieces, [{ index: 0, offset: 0, length: 100, endsFile: true }]);
  assert.equal(overflow, 50);

  // Everything after that is overflow too — no piece escapes.
  const after = cursor.split(64);
  assert.deepEqual(after.pieces, []);
  assert.equal(after.overflow, 64);
});

test("a cursor tracks the running total the checksum comparison relies on", () => {
  const cursor = new BatchCursor([10n, 20n]);
  cursor.split(15);
  assert.equal(cursor.received, 15n);
  assert.equal(cursor.fileIndex, 1);
  assert.equal(cursor.receivedInFile, 5n);
  cursor.split(15);
  assert.equal(cursor.received, 30n);
  assert.equal(cursor.finished, true);
});
