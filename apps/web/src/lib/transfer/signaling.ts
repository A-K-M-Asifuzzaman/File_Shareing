import type { Role, SignalMessage } from "./protocol";

const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL ?? "http://localhost:8080";

export interface SessionCredentials {
  sessionId: string;
  senderToken: string;
  receiverToken: string;
  protocolVersion: number;
  maxTransferBytes: string;
  expiresInSeconds: number;
}

/**
 * Poke the signaling service so it is awake before anyone needs it.
 *
 * The service sleeps when idle, and the first request after that pays the
 * whole cold start — up to about a minute. Waking it when the page loads
 * moves that wait into the time someone spends reading the page and choosing
 * a file, instead of into a spinner after they have committed.
 *
 * Deliberately fire-and-forget: if it fails, createSession reports it later.
 */
export function warmUp(): void {
  void fetch(`${SIGNALING_URL}/healthz`, { cache: "no-store" }).catch(() => undefined);
}

/** Mint a session. Only the sender does this; the receiver arrives with a link. */
export async function createSession(): Promise<SessionCredentials> {
  const res = await fetch(`${SIGNALING_URL}/api/sessions`, { method: "POST" });
  if (!res.ok) {
    throw new Error(
      res.status === 429
        ? "Too many transfers started from here. Wait a minute and try again."
        : "Could not reach the signaling service.",
    );
  }
  return res.json();
}

/**
 * Build the link the receiver opens. The capability goes in the fragment,
 * which browsers never put in the HTTP request — so it stays out of server
 * logs, out of any proxy in between, and out of the Referer header.
 */
export function buildShareUrl(origin: string, sessionId: string, receiverToken: string): string {
  return `${origin}/t/${encodeURIComponent(sessionId)}#token=${encodeURIComponent(receiverToken)}`;
}

/** Read the capability back out of the fragment on the receiver side. */
export function readTokenFromFragment(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token && token.length > 0 ? token : null;
}

type Handlers = {
  onMessage: (msg: SignalMessage) => void;
  onClose: (reason: string) => void;
};

/**
 * Thin WebSocket wrapper that reconnects while it still matters.
 *
 * Until the two peers are linked, this socket is the only way they can find
 * each other — and it drops for entirely ordinary reasons: switching apps to
 * paste the link, a phone locking, a network hop, an idle proxy. Giving up
 * there kills the transfer at exactly the moment the user is doing the one
 * thing the flow asks of them, so it retries with backoff instead.
 *
 * Once the data channel is open, signaling is dead weight and a drop means
 * nothing. Callers say so with retireReconnect().
 */
export class SignalingChannel {
  private ws: WebSocket | null = null;
  private closed = false;

  private reconnect = true;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handlers: Handlers | null = null;

  /** Rejoining is cheap: a disconnect frees the role, and on rejoin the
   *  server says again whether the other peer is already waiting. */
  private static readonly MAX_ATTEMPTS = 8;

  constructor(
    private readonly sessionId: string,
    private readonly role: Role,
    private readonly token: string,
  ) {}

  /** Stop holding the socket open; the peer connection has taken over. */
  retireReconnect(): void {
    this.reconnect = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  connect(handlers: Handlers): Promise<void> {
    this.handlers = handlers;
    return this.open(true);
  }

  private open(first: boolean): Promise<void> {
    const handlers = this.handlers!;
    const base = SIGNALING_URL.replace(/^http/, "ws");
    const url =
      `${base}/ws?session=${encodeURIComponent(this.sessionId)}` +
      `&role=${this.role}&token=${encodeURIComponent(this.token)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        // A good connection resets the budget, so a long wait punctuated by
        // brief drops does not slowly exhaust it.
        this.attempt = 0;
        resolve();
      };

      ws.onmessage = (ev) => {
        try {
          handlers.onMessage(JSON.parse(ev.data as string) as SignalMessage);
        } catch {
          // A malformed frame from our own service is not actionable here;
          // the transfer either proceeds or times out visibly.
        }
      };

      // The server rejects a bad capability before the upgrade, so a failure
      // on the very first attempt is an expired link far more often than a
      // blip — that one is reported rather than retried.
      ws.onerror = () => {
        if (first) reject(new Error("Could not join the transfer session."));
      };

      ws.onclose = () => {
        if (this.closed) return;

        if (this.reconnect && !first) {
          this.scheduleRetry();
          return;
        }
        if (this.reconnect && first) {
          // Opened and then closed: treat as a blip and keep trying, but let
          // the caller past the initial await.
          resolve();
          this.scheduleRetry();
          return;
        }

        this.closed = true;
        handlers.onClose("Signaling connection closed.");
      };
    });
  }

  private scheduleRetry(): void {
    if (this.closed || !this.reconnect) return;

    if (this.attempt >= SignalingChannel.MAX_ATTEMPTS) {
      this.closed = true;
      this.handlers?.onClose("Signaling connection closed.");
      return;
    }

    // 1s, 2s, 4s… capped, so a tab that was backgrounded for a while still
    // retries often enough to be useful without hammering the service.
    const delay = Math.min(1000 * 2 ** this.attempt, 15_000);
    this.attempt++;

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.open(false).catch(() => undefined), delay);
  }

  send(msg: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    this.reconnect = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }
}
