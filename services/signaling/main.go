// Command signaling is the rendezvous service for P2P file transfers.
//
// It introduces two browsers to each other and then gets out of the way. It
// relays SDP offers, answers and ICE candidates between exactly two peers per
// session. It never sees, stores, proxies or inspects file bytes.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

// ProtocolVersion is the transfer protocol both clients must agree on.
// Bumped only on a breaking wire change; see protocol/README.md.
const ProtocolVersion = 1

// MaxTransferBytes is the one place the 100 GB limit is defined. Decimal GB,
// not GiB — the number the UI shows and the number the code enforces are the
// same number. apps/web mirrors this in protocol/limits.ts.
const MaxTransferBytes int64 = 100_000_000_000

// maxSignalBytes caps a single signaling message. SDP for a data-channel-only
// session is a few KB; 64 KiB leaves room without letting a client stream
// junk through the relay.
const maxSignalBytes int64 = 64 << 10

type config struct {
	addr           string
	originPatterns []string
	idleTTL        time.Duration
	activeTTL      time.Duration
	reapEvery      time.Duration
	createPerMin   int
}

// listenAddr resolves where to bind. Hosting platforms assign a port through
// PORT and expect the process to honour it; SIGNALING_ADDR wins when set
// explicitly, so local runs and compose files keep working.
func listenAddr() string {
	if addr := os.Getenv("SIGNALING_ADDR"); addr != "" {
		return addr
	}
	if port := os.Getenv("PORT"); port != "" {
		return ":" + port
	}
	return ":8080"
}

func loadConfig() config {
	return config{
		addr:           listenAddr(),
		originPatterns: strings.Split(env("ALLOWED_ORIGINS", "localhost:3000"), ","),
		idleTTL:        envDuration("SESSION_IDLE_TTL", 10*time.Minute),
		activeTTL:      envDuration("SESSION_ACTIVE_TTL", 30*time.Minute),
		reapEvery:      envDuration("SESSION_REAP_EVERY", time.Minute),
		createPerMin:   envInt("CREATE_RATE_PER_MIN", 30),
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envDuration(k string, def time.Duration) time.Duration {
	if v, err := time.ParseDuration(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return def
}

type server struct {
	cfg     config
	store   *Store
	log     *slog.Logger
	limiter *rateLimiter
}

func main() {
	cfg := loadConfig()
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	srv := &server{
		cfg:     cfg,
		store:   NewStore(cfg.idleTTL, cfg.activeTTL),
		log:     log,
		limiter: newRateLimiter(cfg.createPerMin, time.Minute),
	}

	stop := make(chan struct{})
	go srv.store.ReapLoop(cfg.reapEvery, stop, func(n int) {
		log.Info("reaped expired sessions", "count", n, "remaining", srv.store.Len())
	})

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions", srv.handleCreateSession)
	mux.HandleFunc("GET /ws", srv.handleWS)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ready": true, "sessions": srv.store.Len()})
	})

	httpSrv := &http.Server{
		Addr:              cfg.addr,
		Handler:           srv.withCORS(mux),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: WebSocket connections are long-lived by design.
	}

	go func() {
		log.Info("signaling listening",
			"addr", cfg.addr,
			"origins", cfg.originPatterns,
			"idleTTL", cfg.idleTTL.String(),
			"activeTTL", cfg.activeTTL.String(),
		)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen failed", "err", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	log.Info("shutting down")
	close(stop)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}

// --- HTTP ---

type createSessionResponse struct {
	SessionID        string `json:"sessionId"`
	SenderToken      string `json:"senderToken"`
	ReceiverToken    string `json:"receiverToken"`
	ProtocolVersion  int    `json:"protocolVersion"`
	MaxTransferBytes string `json:"maxTransferBytes"` // decimal string: exceeds 2^53
	ExpiresInSeconds int    `json:"expiresInSeconds"`
}

func (s *server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many sessions, slow down")
		return
	}

	sess, senderToken, receiverToken, err := s.store.Create()
	if err != nil {
		s.log.Error("create session failed", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "could not create session")
		return
	}

	// sessionId is safe to log. Tokens never are.
	s.log.Info("session created", "sessionId", sess.ID, "sessions", s.store.Len())

	writeJSON(w, http.StatusCreated, createSessionResponse{
		SessionID:        sess.ID,
		SenderToken:      senderToken,
		ReceiverToken:    receiverToken,
		ProtocolVersion:  ProtocolVersion,
		MaxTransferBytes: strconv.FormatInt(MaxTransferBytes, 10),
		ExpiresInSeconds: int(s.cfg.idleTTL.Seconds()),
	})
}

func (s *server) withCORS(next http.Handler) http.Handler {
	allowed := make(map[string]bool, len(s.cfg.originPatterns))
	for _, o := range s.cfg.originPatterns {
		o = strings.TrimSpace(o)
		allowed["http://"+o] = true
		allowed["https://"+o] = true
		allowed[o] = true // already a full origin
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- WebSocket relay ---

// peer is one connected side of a session.
type peer struct {
	send      chan []byte
	closeOnce sync.Once
	done      chan struct{}
}

func newPeer() *peer {
	return &peer{
		// Buffered: signaling is bursty (a flood of ICE candidates) but small.
		send: make(chan []byte, 64),
		done: make(chan struct{}),
	}
}

func (p *peer) close() { p.closeOnce.Do(func() { close(p.done) }) }

// deliver queues a message. A peer that cannot keep up with 64 pending
// signaling messages is broken or hostile; drop it rather than stalling the
// other side.
func (p *peer) deliver(msg []byte) bool {
	select {
	case p.send <- msg:
		return true
	case <-p.done:
		return false
	default:
		p.close()
		return false
	}
}

func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sessionID := q.Get("session")
	role := Role(q.Get("role"))
	token := q.Get("token")

	// Authenticate before upgrading. An unauthorized caller gets a plain HTTP
	// status and never costs us a WebSocket handshake or a goroutine.
	sess, err := s.store.Authenticate(sessionID, role, token)
	if err != nil {
		// One status for both cases: do not tell a prober whether the session
		// exists or the token was merely wrong.
		s.log.Info("ws auth rejected", "sessionId", sessionID, "role", role, "reason", err.Error())
		writeErr(w, http.StatusUnauthorized, "unauthorized", "invalid session or token")
		return
	}

	// A reconnection replaces whatever held this role. The caller proved the
	// capability, so it is the same party coming back — refusing it would
	// strand them for as long as the dead socket lingers.
	p := newPeer()
	if evicted := s.store.attach(sess, role, p); evicted != nil {
		s.log.Info("replacing a stale connection", "sessionId", sess.ID, "role", role)
		evicted.close()
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: s.cfg.originPatterns,
	})
	if err != nil {
		s.log.Warn("ws accept failed", "sessionId", sess.ID, "err", err)
		return
	}
	conn.SetReadLimit(maxSignalBytes)
	defer conn.CloseNow()

	s.log.Info("peer connected", "sessionId", sess.ID, "role", role, "peers", sess.peerCount())

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Tell each side about the other so the sender knows when to make an offer.
	if other, ok := sess.peerFor(role); ok {
		other.deliver(event("peer-joined", string(role)))
		p.deliver(event("peer-joined", string(role.other())))
	}

	go s.writePump(ctx, conn, p)
	s.readPump(ctx, conn, sess, role, p)

	// Only announce a departure if this connection was still the one holding
	// the role. A reconnection replaces the entry, and the old socket's
	// cleanup arriving afterwards must not tell the other side that a peer
	// who is right there has left — that false alarm ended transfers that
	// had already recovered.
	if s.store.detach(sess, role, p) {
		if other, ok := sess.peerFor(role); ok {
			other.deliver(event("peer-left", string(role)))
		}
		s.log.Info("peer disconnected", "sessionId", sess.ID, "role", role)
		return
	}
	s.log.Info("stale connection closed", "sessionId", sess.ID, "role", role)
}

func (s *server) writePump(ctx context.Context, conn *websocket.Conn, p *peer) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.done:
			_ = conn.Close(websocket.StatusPolicyViolation, "too slow")
			return
		case msg := <-p.send:
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

// readPump relays every valid message to the opposite peer. The server does
// not parse SDP or candidates — it checks the envelope and forwards the
// original bytes untouched.
func (s *server) readPump(ctx context.Context, conn *websocket.Conn, sess *Session, role Role, p *peer) {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			_ = conn.Close(websocket.StatusUnsupportedData, "text frames only")
			return
		}
		if !validEnvelope(data) {
			p.deliver(event("error", "malformed signaling message"))
			continue
		}

		s.store.touch(sess)

		other, ok := sess.peerFor(role)
		if !ok {
			p.deliver(event("peer-absent", ""))
			continue
		}
		other.deliver(data)
	}
}

// validEnvelope checks a message is a JSON object carrying a non-empty "type".
// Anything beyond that is the peers' business, not ours.
func validEnvelope(data []byte) bool {
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return false
	}
	return env.Type != ""
}

func event(kind, detail string) []byte {
	b, _ := json.Marshal(map[string]string{"type": kind, "detail": detail})
	return b
}

// --- small helpers ---

// rateLimiter is a fixed-window counter per key.
//
// ponytail: fixed window allows a 2x burst across a window boundary. That is
// acceptable for "stop someone minting a million sessions"; swap in
// golang.org/x/time/rate if this ever needs to be precise.
type rateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*windowCount
}

type windowCount struct {
	n     int
	start time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, window: window, hits: map[string]*windowCount{}}
}

func (l *rateLimiter) allow(key string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	// Opportunistic cleanup so the map does not grow forever.
	if len(l.hits) > 10_000 {
		for k, c := range l.hits {
			if now.Sub(c.start) > l.window {
				delete(l.hits, k)
			}
		}
	}

	c, ok := l.hits[key]
	if !ok || now.Sub(c.start) > l.window {
		l.hits[key] = &windowCount{n: 1, start: now}
		return true
	}
	c.n++
	return c.n <= l.limit
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": code, "message": msg})
}
