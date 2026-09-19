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
 * Thin WebSocket wrapper. Deliberately not reconnecting: once the WebRTC
 * connection is up, signaling is no longer needed, and a dropped socket
 * before that means the transfer has failed in a way the user must see.
 *
 * ponytail: no reconnect. Add one only if real sessions turn out to drop the
 * socket mid-negotiation often enough to matter.
 */
export class SignalingChannel {
  private ws: WebSocket | null = null;
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly role: Role,
    private readonly token: string,
  ) {}

  connect(handlers: Handlers): Promise<void> {
    const base = SIGNALING_URL.replace(/^http/, "ws");
    const url =
      `${base}/ws?session=${encodeURIComponent(this.sessionId)}` +
      `&role=${this.role}&token=${encodeURIComponent(this.token)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => resolve();

      ws.onmessage = (ev) => {
        try {
          handlers.onMessage(JSON.parse(ev.data as string) as SignalMessage);
        } catch {
          // A malformed frame from our own service is not actionable here;
          // the transfer either proceeds or times out visibly.
        }
      };

      // The server rejects a bad capability before the upgrade, so a failure
      // here is an expired link far more often than a broken service.
      ws.onerror = () => reject(new Error("Could not join the transfer session."));

      ws.onclose = () => {
        if (this.closed) return;
        this.closed = true;
        handlers.onClose("Signaling connection closed.");
        reject(new Error("This link has expired or was already used."));
      };
    });
  }

  send(msg: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}
