// End-to-end smoke test for the signaling service.
// Usage: PORT=8787 node smoke.mjs
const PORT = process.env.PORT || '8787';
const BASE = `http://127.0.0.1:${PORT}`;
const WSB = `ws://127.0.0.1:${PORT}`;

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok = (m) => console.log('  ok  ', m);

setTimeout(() => fail('timed out after 20s'), 20_000).unref?.();

// Queue every inbound message so a test never loses one that arrived before
// it got around to asking.
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const w = waiters.shift();
      if (w) w(msg); else queue.push(msg);
    };
    ws.next = () => queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((r) => waiters.push(r));
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('handshake refused'));
    ws.onclose = (e) => reject(new Error(`closed ${e.code}`));
  });
}

const refused = async (url, what) => {
  try { await connect(url); fail(what); } catch { ok(what.replace(/^/, 'refused: ')); }
};

// 1. session creation
const res = await fetch(`${BASE}/api/sessions`, { method: 'POST' });
if (res.status !== 201) fail(`create returned ${res.status}`);
const s = await res.json();
if (!s.sessionId || !s.senderToken || !s.receiverToken) fail('response missing fields');
if (s.senderToken === s.receiverToken) fail('both roles got the same token');
if (s.maxTransferBytes !== '100000000000') fail(`limit = ${s.maxTransferBytes}`);
ok(`session created — protocol v${s.protocolVersion}, limit ${s.maxTransferBytes} bytes`);

const url = (role, token) => `${WSB}/ws?session=${s.sessionId}&role=${role}&token=${token}`;

// 2. capabilities are role-scoped and non-forgeable
await refused(url('receiver', s.senderToken), 'sender token on the receiver slot');
await refused(url('sender', s.receiverToken), 'receiver token on the sender slot');
await refused(url('sender', 'made-up-token'), 'invented token');
await refused(`${WSB}/ws?session=nope&role=sender&token=${s.senderToken}`, 'unknown session id');

// 3. both peers connect and each learns about the other
const sender = await connect(url('sender', s.senderToken));
const receiver = await connect(url('receiver', s.receiverToken));

const a = await sender.next();
if (a.type !== 'peer-joined' || a.detail !== 'receiver') fail(`sender saw ${JSON.stringify(a)}`);
ok('sender notified the receiver joined');

const b = await receiver.next();
if (b.type !== 'peer-joined' || b.detail !== 'sender') fail(`receiver saw ${JSON.stringify(b)}`);
ok('receiver notified the sender is present');

// 4. an offer crosses the relay unmodified
const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 AB:CD\r\n';
sender.send(JSON.stringify({ type: 'offer', sdp }));
const relayed = await receiver.next();
if (relayed.type !== 'offer' || relayed.sdp !== sdp) fail(`relayed ${JSON.stringify(relayed)}`);
ok('SDP offer relayed byte-for-byte, sender -> receiver');

// 5. and back the other way
receiver.send(JSON.stringify({ type: 'answer', sdp }));
const back = await sender.next();
if (back.type !== 'answer') fail(`expected answer, got ${JSON.stringify(back)}`);
ok('answer relayed receiver -> sender');

// 6. malformed input is rejected without killing the connection
sender.send('not json at all');
const err = await sender.next();
if (err.type !== 'error') fail(`expected error, got ${JSON.stringify(err)}`);
sender.send(JSON.stringify({ type: 'ice', candidate: 'candidate:1 1 UDP' }));
const survived = await receiver.next();
if (survived.type !== 'ice') fail('connection did not survive a malformed message');
ok('malformed message rejected, connection survived');

// 7. the session holds exactly two peers
await refused(url('sender', s.senderToken), 'a second sender');

// 8. departure is announced
receiver.close();
const left = await sender.next();
if (left.type !== 'peer-left' || left.detail !== 'receiver') fail(`expected peer-left, got ${JSON.stringify(left)}`);
ok('peer-left announced to the remaining side');

sender.close();
console.log('\nall smoke checks passed');
process.exit(0);
