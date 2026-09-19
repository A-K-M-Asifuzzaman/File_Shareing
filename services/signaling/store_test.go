package main

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func newTestStore(t *testing.T) (*Store, *time.Time) {
	t.Helper()
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s := NewStore(10*time.Minute, 30*time.Minute)
	s.now = func() time.Time { return clock }
	return s, &clock
}

func TestAuthenticateAcceptsCorrectTokenPerRole(t *testing.T) {
	s, _ := newTestStore(t)
	sess, senderTok, receiverTok, err := s.Create()
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := s.Authenticate(sess.ID, RoleSender, senderTok); err != nil {
		t.Errorf("sender token rejected: %v", err)
	}
	if _, err := s.Authenticate(sess.ID, RoleReceiver, receiverTok); err != nil {
		t.Errorf("receiver token rejected: %v", err)
	}

	// The whole point of two capabilities: one must not open the other's door.
	if _, err := s.Authenticate(sess.ID, RoleReceiver, senderTok); !errors.Is(err, ErrBadToken) {
		t.Errorf("sender token opened receiver role, got err=%v", err)
	}
	if _, err := s.Authenticate(sess.ID, RoleSender, receiverTok); !errors.Is(err, ErrBadToken) {
		t.Errorf("receiver token opened sender role, got err=%v", err)
	}
}

func TestAuthenticateRejectsGarbage(t *testing.T) {
	s, _ := newTestStore(t)
	sess, senderTok, _, _ := s.Create()

	cases := []struct {
		name, id, token string
		role            Role
		want            error
	}{
		{"unknown session", "nope", senderTok, RoleSender, ErrNotFound},
		{"empty token", sess.ID, "", RoleSender, ErrBadToken},
		{"wrong token", sess.ID, senderTok + "x", RoleSender, ErrBadToken},
		{"bogus role", sess.ID, senderTok, Role("admin"), ErrBadToken},
	}
	for _, c := range cases {
		if _, err := s.Authenticate(c.id, c.role, c.token); !errors.Is(err, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, err, c.want)
		}
	}
}

func TestTokensAreNotStoredRaw(t *testing.T) {
	s, _ := newTestStore(t)
	sess, senderTok, receiverTok, _ := s.Create()

	// A memory dump of the session must not hand out either capability.
	if string(sess.senderHash[:]) == senderTok || string(sess.receiverHash[:]) == receiverTok {
		t.Fatal("session holds a raw token")
	}
	if sess.senderHash == sess.receiverHash {
		t.Fatal("both roles share one digest")
	}
}

func TestIdleSessionExpiresAndIsReaped(t *testing.T) {
	s, clock := newTestStore(t)
	sess, tok, _, _ := s.Create()

	*clock = clock.Add(11 * time.Minute) // past the 10m idle TTL

	if _, err := s.Authenticate(sess.ID, RoleSender, tok); !errors.Is(err, ErrNotFound) {
		t.Errorf("expired session still authenticated: %v", err)
	}
	if s.Len() != 0 {
		t.Errorf("expired session not dropped on auth, %d left", s.Len())
	}

	s.Create()
	*clock = clock.Add(11 * time.Minute)
	if n := s.Reap(); n != 1 {
		t.Errorf("Reap removed %d, want 1", n)
	}
}

func TestActiveSessionSurvivesPastIdleTTL(t *testing.T) {
	s, clock := newTestStore(t)
	sess, tok, _, _ := s.Create()

	s.attach(sess, RoleSender, newPeer())

	// A big transfer runs far longer than the idle window. Traffic keeps it alive.
	for range 5 {
		*clock = clock.Add(9 * time.Minute)
		s.touch(sess)
	}
	*clock = clock.Add(9 * time.Minute)

	if _, err := s.Authenticate(sess.ID, RoleSender, tok); err != nil {
		t.Errorf("active session expired mid-transfer: %v", err)
	}
}

func TestReconnectReplacesTheStaleConnection(t *testing.T) {
	s, _ := newTestStore(t)
	sess, _, _, _ := s.Create()

	// A dropped socket is often still registered when its owner comes back —
	// switching apps to send the link is enough to cause it. The returning
	// party holds the capability, so they take the role over.
	stale := newPeer()
	if evicted := s.attach(sess, RoleSender, stale); evicted != nil {
		t.Fatalf("nothing should have been evicted on the first attach")
	}

	fresh := newPeer()
	evicted := s.attach(sess, RoleSender, fresh)
	if evicted != stale {
		t.Fatalf("reconnect did not evict the stale peer")
	}
	if p := sess.peers[RoleSender]; p != fresh {
		t.Error("the role is not held by the reconnected peer")
	}

	// Still one slot per role: a receiver is separate, and there are two.
	s.attach(sess, RoleReceiver, newPeer())
	if sess.peerCount() != 2 {
		t.Errorf("peers = %d, want 2", sess.peerCount())
	}
}

func TestStaleCleanupNeitherEvictsNorAnnouncesADeparture(t *testing.T) {
	s, _ := newTestStore(t)
	sess, _, _, _ := s.Create()

	old := newPeer()
	s.attach(sess, RoleSender, old)

	fresh := newPeer()
	s.attach(sess, RoleSender, fresh)

	// The dead connection's handler finally exits. It must not remove its
	// own replacement, and — the bug that ended recovered transfers — the
	// caller must not use it to tell the other side the peer has left.
	if removed := s.detach(sess, RoleSender, old); removed {
		t.Error("stale detach reported a removal, which would announce a false departure")
	}
	if p, ok := sess.peers[RoleSender]; !ok || p != fresh {
		t.Error("stale detach evicted the reconnected peer")
	}

	// The real one does report, so a genuine departure is still announced.
	if removed := s.detach(sess, RoleSender, fresh); !removed {
		t.Error("detaching the current peer should report a removal")
	}
}

func TestPeerForReturnsTheOtherSide(t *testing.T) {
	s, _ := newTestStore(t)
	sess, _, _, _ := s.Create()

	sender, receiver := newPeer(), newPeer()
	s.attach(sess, RoleSender, sender)
	s.attach(sess, RoleReceiver, receiver)

	if p, _ := sess.peerFor(RoleSender); p != receiver {
		t.Error("sender's peer is not the receiver")
	}
	if p, _ := sess.peerFor(RoleReceiver); p != sender {
		t.Error("receiver's peer is not the sender")
	}
}

func TestSlowPeerIsDroppedNotBlocking(t *testing.T) {
	p := newPeer()
	for range cap(p.send) {
		if !p.deliver([]byte(`{"type":"x"}`)) {
			t.Fatal("deliver failed while buffer had room")
		}
	}
	// Buffer full: the relay must give up on this peer instead of stalling.
	if p.deliver([]byte(`{"type":"x"}`)) {
		t.Error("delivered past capacity")
	}
	select {
	case <-p.done:
	default:
		t.Error("over-capacity peer was not closed")
	}
}

func TestValidEnvelope(t *testing.T) {
	ok := []string{`{"type":"offer","sdp":"v=0..."}`, `{"type":"ice","candidate":{}}`}
	bad := []string{``, `not json`, `{}`, `{"type":""}`, `[{"type":"offer"}]`, `"offer"`}

	for _, m := range ok {
		if !validEnvelope([]byte(m)) {
			t.Errorf("rejected valid message: %s", m)
		}
	}
	for _, m := range bad {
		if validEnvelope([]byte(m)) {
			t.Errorf("accepted invalid message: %s", m)
		}
	}
}

func TestRateLimiterWindow(t *testing.T) {
	l := newRateLimiter(3, time.Minute)
	for i := range 3 {
		if !l.allow("1.2.3.4") {
			t.Fatalf("blocked request %d within limit", i+1)
		}
	}
	if l.allow("1.2.3.4") {
		t.Error("4th request allowed past limit of 3")
	}
	if !l.allow("5.6.7.8") {
		t.Error("a different IP was blocked")
	}
}

func TestSessionIDsAreUnpredictableAndUnique(t *testing.T) {
	s, _ := newTestStore(t)
	seen := make(map[string]bool, 1000)
	for range 1000 {
		sess, _, _, err := s.Create()
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		if seen[sess.ID] {
			t.Fatalf("duplicate session id %q", sess.ID)
		}
		if len(sess.ID) < 20 {
			t.Fatalf("session id too short to be unguessable: %q", sess.ID)
		}
		seen[sess.ID] = true
	}
}

// Run with -race: the store is touched from every connection goroutine.
func TestConcurrentCreateAndReap(t *testing.T) {
	s := NewStore(time.Millisecond, time.Millisecond)

	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sess, tok, _, err := s.Create()
			if err != nil {
				t.Error(err)
				return
			}
			s.Authenticate(sess.ID, RoleSender, tok)
			s.touch(sess)
			s.Reap()
		}()
	}
	wg.Wait()
}
