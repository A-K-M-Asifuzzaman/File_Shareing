/**
 * A real transfer between two browser pages.
 *
 * Run:  npm run e2e            (needs the signaling service and `npm start` up)
 *       BASE=… SIGNALING=… npm run e2e
 *
 * The unit tests pin the protocol's arithmetic; this pins the thing they
 * cannot reach — that the manifest, the ICE handshake, the data channel, the
 * batch routing, the backpressure and the per-file checksums all work
 * together, against a real signaling service, with bytes that actually move.
 *
 * It exists because they did not: the first run of this script found the
 * receiver dropping the tail of a transfer, on every transfer, while every
 * unit test passed.
 *
 * The save dialog is native and cannot be driven, so the File System Access
 * API is stubbed in the receiver page — files land in memory and are hashed
 * there, which is what makes the assertion about the bytes that arrived rather
 * than about what the UI claims. Nothing else is faked.
 */
import { chromium } from "playwright-core";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3000";

/**
 * Sizes chosen to break the batch router if it is wrong: one file much larger
 * than a chunk, one smaller than a chunk, one a single byte over a chunk
 * boundary, and a tail. Between them every chunk case occurs — whole-file,
 * straddling, and exactly-on-the-boundary.
 */
const SPEC = [
  ["big.bin", 3 * 1024 * 1024 + 777],
  ["tiny.txt", 3],
  ["odd.bin", 64 * 1024 + 1],
  ["last.bin", 120_000],
];

let failures = 0;
const fail = (m) => {
  console.error(`  ✕ ${m}`);
  failures++;
};
const pass = (m) => console.log(`  ✓ ${m}`);

/** Write the payload to a temp dir and remember what it should hash to. */
function makePayload(spec) {
  const dir = mkdtempSync(path.join(tmpdir(), "direct-e2e-"));
  const expected = {};
  for (const [name, size] of spec) {
    const buf = randomBytes(size);
    writeFileSync(path.join(dir, name), buf);
    expected[name] = { size, sha256: createHash("sha256").update(buf).digest("hex") };
  }
  return { dir, expected };
}

/**
 * Stand in for the save and folder dialogs. Runs before any page script, so
 * the receiver never knows the difference.
 */
const RECEIVER_STUB = () => {
  const received = {};
  window.__received = received;

  const writable = (name) => {
    const parts = [];
    return {
      async write(chunk) {
        // Copy, do not view: the receiver hands this buffer to the hashing
        // worker immediately after, which detaches it — a view would read
        // back as zeroes and this harness would blame the app.
        parts.push(new Uint8Array(chunk).slice());
      },
      async truncate() {
        parts.length = 0;
      },
      async close() {
        const total = parts.reduce((n, p) => n + p.length, 0);
        const all = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
          all.set(p, at);
          at += p.length;
        }
        const digest = await crypto.subtle.digest("SHA-256", all);
        received[name] = {
          size: total,
          sha256: [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
        };
      },
      async abort() {
        parts.length = 0;
        received[name] = { aborted: true };
      },
    };
  };

  const directory = (dirName) => ({
    name: dirName,
    async getFileHandle(name, opts) {
      // The real API throws NotFoundError for a name that is free, which is
      // how the receiver tests for collisions.
      if (!opts?.create) throw new DOMException("not found", "NotFoundError");
      return { name, createWritable: async () => writable(name) };
    },
    async getDirectoryHandle(name) {
      return directory(name);
    },
    async removeEntry() {},
  });

  window.showDirectoryPicker = async () => directory("e2e-inbox");
  window.showSaveFilePicker = async (opts) => ({
    name: opts?.suggestedName ?? "received",
    createWritable: async () => writable(opts?.suggestedName ?? "received"),
  });
};

/**
 * Text that means the two pages never managed to pair up.
 *
 * ICE is best-effort by nature and two pages on one machine still have to get
 * through whatever the host's interfaces and firewall are doing, so a single
 * connection failure says nothing about the protocol. Only this is retried —
 * a short file, a wrong checksum or a transfer that connects and then stalls
 * is a real failure and is reported as one.
 */
const CONNECT_FAILURE = /Could not open a direct connection|left before the transfer started|no longer online/;

async function transferWithRetry(browser, dir, names, opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await transfer(browser, dir, names, opts);
    if (!result.connectFailed) return result.got;
    if (attempt < 3) console.log(`  … ICE did not pair, retrying (${attempt}/2)`);
    else fail(`${opts.label}: could not establish a connection in 3 attempts`);
  }
  return {};
}

async function transfer(browser, dir, names, { label }) {
  const sender = await browser.newPage();
  const receiver = await browser.newPage();
  await receiver.addInitScript(RECEIVER_STUB);

  // ICE is the one layer that fails for reasons outside this repo, so it can
  // be traced without editing the test: E2E_TRACE=1 prints candidates and
  // connection states from both pages.
  if (process.env.E2E_TRACE) {
    const trace = () => {
      const Original = window.RTCPeerConnection;
      window.RTCPeerConnection = function (cfg) {
        const pc = new Original(cfg);
        console.log(`servers=${JSON.stringify(cfg?.iceServers ?? [])}`);
        for (const ev of ["iceconnectionstatechange", "connectionstatechange"]) {
          pc.addEventListener(ev, () => console.log(`${pc.iceConnectionState}/${pc.connectionState}`));
        }
        pc.addEventListener("icecandidate", (e) =>
          console.log(`cand ${e.candidate ? `${e.candidate.type} ${e.candidate.address}` : "END"}`),
        );
        return pc;
      };
      window.RTCPeerConnection.prototype = Original.prototype;
    };
    await sender.addInitScript(trace);
    await receiver.addInitScript(trace);
    sender.on("console", (m) => console.log(`    [sender] ${m.text()}`));
    receiver.on("console", (m) => console.log(`    [receiver] ${m.text()}`));
  }

  for (const [who, page] of [
    ["sender", sender],
    ["receiver", receiver],
  ]) {
    page.on("pageerror", (e) => fail(`${label}: ${who} page error: ${e.message}`));
  }

  await sender.goto(BASE, { waitUntil: "domcontentloaded" });
  await sender
    .locator('input[type="file"]')
    .first()
    .setInputFiles(names.map((n) => path.join(dir, n)));

  const ready = names.length === 1 ? "1 file ready" : `${names.length} files ready`;
  await sender.getByText(ready).waitFor({ timeout: 15_000 });

  await sender.getByRole("button", { name: "Create the link" }).click();

  const linkBox = sender.locator("p.tabular").filter({ hasText: "#token=" }).first();
  await linkBox.waitFor({ timeout: 45_000 });
  const shareUrl = (await linkBox.textContent()).trim();

  // The QR carries the capability in the fragment; losing it silently would
  // break the one hand-off this product is built around.
  if ((await sender.locator('svg[aria-label="QR code for the transfer link"]').count()) !== 1) {
    fail(`${label}: no QR code beside the share link`);
  }

  /** Report, and say whether this was merely a failure to connect. */
  const report = async (err, what) => {
    let connectFailed = false;
    for (const [who, page] of [
      ["sender", sender],
      ["receiver", receiver],
    ]) {
      const text = await page.locator("main").innerText().catch(() => "<unreadable>");
      if (CONNECT_FAILURE.test(text)) connectFailed = true;
      else console.error(`\n--- ${label}: ${who} ---\n${text}\n`);
    }
    if (!connectFailed) fail(`${label}: ${what} — ${err.message.split("\n")[0]}`);
    return connectFailed;
  };

  const done = async (connectFailed, got) => {
    await sender.close();
    await receiver.close();
    return { connectFailed, got: got ?? {} };
  };

  await receiver.goto(shareUrl, { waitUntil: "domcontentloaded" });

  try {
    await receiver.getByRole("button", { name: /^Accept and/ }).click({ timeout: 45_000 });
  } catch (err) {
    return done(await report(err, "the offer never arrived"));
  }

  try {
    await receiver.getByText(/Transfer complete/).waitFor({ timeout: 120_000 });
    await sender.getByText(/Sent and verified/).waitFor({ timeout: 60_000 });
  } catch (err) {
    return done(await report(err, "never completed"));
  }

  // Success has to survive the teardown that follows it. The receiver closes
  // the peer connection as soon as it has verified everything, which reaches
  // the sender as a failed connection state a moment later — and that used to
  // replace "Sent and verified" with "could not open a direct connection" on a
  // transfer that had just worked perfectly.
  await sender.waitForTimeout(3000);
  const settled = await sender.locator("main").innerText();
  if (!/Sent and verified/.test(settled) || CONNECT_FAILURE.test(settled)) {
    fail(`${label}: the sender's success was overwritten after teardown`);
    console.error(`\n--- ${label}: sender after teardown ---\n${settled}\n`);
  } else {
    pass(`${label}: success survives the connection closing`);
  }

  return done(false, await receiver.evaluate(() => window.__received));
}

/* -------------------------------------------------------------------------- */

const { dir, expected } = makePayload(SPEC);
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: [
    "--no-sandbox",
    // Chrome hides local IPs behind mDNS `.local` candidates. Two pages in one
    // browser still have to resolve each other's name over multicast DNS, and
    // that is blocked or unanswered on plenty of hosts — ICE then reaches
    // "checking", never pairs, and the app correctly reports that it could not
    // connect. Turning the obfuscation off keeps this test about the transfer
    // rather than about the host's mDNS.
    "--disable-features=WebRtcHideLocalIpsWithMdns",
  ],
});

try {
  // Prime the browser's ICE machinery before timing anything against it. The
  // first peer connection after launch has to resolve mDNS and reach STUN
  // cold, which can outlast ICE's own patience — the second one never does.
  // The diagnostics page already gathers candidates for its own reasons, so
  // loading it both warms the browser and checks that page still works.
  const warm = await browser.newPage();
  await warm.goto(`${BASE}/diagnostics`, { waitUntil: "domcontentloaded" });
  await warm.getByRole("button", { name: "Run again" }).waitFor({ timeout: 60_000 });
  const verdicts = await warm.locator('[role="img"][aria-label]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("aria-label")),
  );
  if (verdicts.includes("fail")) {
    console.log(`  ! diagnostics reported a failing check: ${verdicts.join(", ")}`);
  } else {
    pass(`diagnostics: ${verdicts.length} checks, none failing`);
  }
  await warm.close();

  // The common case first: one file, through the save picker.
  console.log("\none file, save picker:");
  const single = await transferWithRetry(browser, dir, ["big.bin"], { label: "single" });
  check(single, ["big.bin"]);

  // Then the batch, through the folder picker.
  console.log(`\n${SPEC.length} files, folder picker:`);
  const batch = await transferWithRetry(browser, dir, SPEC.map(([n]) => n), { label: "batch" });
  check(batch, SPEC.map(([n]) => n));
} finally {
  await browser.close();
}

function check(got, names) {
  for (const name of names) {
    const want = expected[name];
    const have = got[name];
    if (!have) {
      fail(`${name}: never written`);
    } else if (have.size !== want.size) {
      fail(`${name}: ${have.size} bytes, expected ${want.size}`);
    } else if (have.sha256 !== want.sha256) {
      fail(`${name}: checksum mismatch — the bytes are wrong, not just short`);
    } else {
      pass(`${name} — ${have.size} bytes, sha256 matches`);
    }
  }
  const extra = Object.keys(got).filter((n) => !names.includes(n));
  if (extra.length > 0) fail(`wrote files nobody asked for: ${extra.join(", ")}`);
}

console.log(failures === 0 ? "\nE2E passed" : `\nE2E failed: ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
