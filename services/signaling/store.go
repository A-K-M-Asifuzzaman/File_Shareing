package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

// Role identifies which side of a transfer a connection claims to be.
type Role string

const (
	RoleSender   Role = "sender"
	RoleReceiver Role = "receiver"
)

func (r Role) valid() bool { return r == RoleSender || r == RoleReceiver }

func (r Role) other() Role {
	if r == RoleSender {
		return RoleReceiver
	}
	return RoleSender
}

var (
	ErrNotFound  = errors.New("session not found")
	ErrBadToken  = errors.New("invalid capability token")
	ErrRoleTaken = errors.New("role already connected")
)

// Session is one transfer rendezvous. It holds no file data and no file
// metadata — only what two peers need to find each other and prove they were
// invited. Tokens are stored as SHA-256 digests so a memory dump or a log leak
// does not hand out the capability itself.
type Session struct {
	ID        string
	CreatedAt time.Time

	senderHash   [32]byte
	receiverHash [32]byte

	mu        sync.Mutex
	peers     map[Role]*peer
	expiresAt time.Time
}

// Store keeps sessions in memory. Everything is reachable through this one
// interface so a Redis-backed implementation can replace it when signaling
// runs on more than one instance.
//
// ponytail: one mutex guards the whole map. Fine for a single instance at
// human session-creation rates; shard or move to Redis when it measurably hurts.
type Store struct {
	mu       sync.Mutex
	sessions map[string]*Session

	idleTTL   time.Duration // a session nobody has connected to yet
	activeTTL time.Duration // refreshed while peers are connected

	now func() time.Time // injectable so tests do not sleep
}

func NewStore(idleTTL, activeTTL time.Duration) *Store {
	return &Store{
		sessions:  make(map[string]*Session),
		idleTTL:   idleTTL,
		activeTTL: activeTTL,
		now:       time.Now,
	}
}

// newToken returns a 256-bit capability and its digest. The raw value is
// returned exactly once, to the creator, and never stored or logged.
func newToken() (string, [32]byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", [32]byte{}, err
	}
	tok := base64.RawURLEncoding.EncodeToString(b)
	return tok, sha256.Sum256([]byte(tok)), nil
}

// Create mints a session plus the two capabilities that open it. The sender
// keeps senderToken; receiverToken travels in the share URL fragment.
func (s *Store) Create() (sess *Session, senderToken, receiverToken string, err error) {
	idBytes := make([]byte, 16)
	if _, err = rand.Read(idBytes); err != nil {
		return nil, "", "", err
	}

	senderToken, senderHash, err := newToken()
	if err != nil {
		return nil, "", "", err
	}
	receiverToken, receiverHash, err := newToken()
	if err != nil {
		return nil, "", "", err
	}

	now := s.now()
	sess = &Session{
		ID:           base64.RawURLEncoding.EncodeToString(idBytes),
		CreatedAt:    now,
		senderHash:   senderHash,
		receiverHash: receiverHash,
		peers:        make(map[Role]*peer, 2),
		expiresAt:    now.Add(s.idleTTL),
	}

	s.mu.Lock()
	s.sessions[sess.ID] = sess
	s.mu.Unlock()

	return sess, senderToken, receiverToken, nil
}

// Authenticate resolves a session and checks the caller holds the capability
// for the role it claims. Comparison is constant-time: a timing difference
// here would leak the token a byte at a time.
func (s *Store) Authenticate(id string, role Role, token string) (*Session, error) {
	if !role.valid() {
		return nil, ErrBadToken
	}

	s.mu.Lock()
	sess, ok := s.sessions[id]
	s.mu.Unlock()
	if !ok {
		return nil, ErrNotFound
	}

	if sess.expired(s.now()) {
		s.Delete(id)
		return nil, ErrNotFound
	}

	want := sess.senderHash
	if role == RoleReceiver {
		want = sess.receiverHash
	}
	got := sha256.Sum256([]byte(token))
	if subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
		return nil, ErrBadToken
	}
	return sess, nil
}

func (s *Store) Get(id string) (*Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	return sess, ok
}

func (s *Store) Delete(id string) {
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

// Reap drops expired sessions and returns how many it removed.
func (s *Store) Reap() int {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()

	n := 0
	for id, sess := range s.sessions {
		if sess.expired(now) {
			delete(s.sessions, id)
			n++
		}
	}
	return n
}

// ReapLoop runs Reap until ctx-like stop channel closes.
func (s *Store) ReapLoop(every time.Duration, stop <-chan struct{}, onReap func(int)) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			if n := s.Reap(); n > 0 && onReap != nil {
				onReap(n)
			}
		}
	}
}

// attach registers a connected peer for a role, replacing whatever was there.
//
// Reconnection is normal, not exceptional: a phone switching to a messaging
// app to send the link, a laptop sleeping, a network hop. The old socket is
// often still registered when the new one arrives, because a dropped TCP
// connection takes a while to be noticed. Refusing the new connection in that
// window strands the party who is trying to come back — and they hold the
// capability for this role, so they are the same party by definition.
//
// Returns the evicted peer, if any, so the caller can close it out.
func (s *Store) attach(sess *Session, role Role, p *peer) *peer {
	sess.mu.Lock()
	defer sess.mu.Unlock()

	evicted := sess.peers[role]
	sess.peers[role] = p
	sess.expiresAt = s.now().Add(s.activeTTL)
	return evicted
}

// detach removes a peer and reports whether it was still the registered one.
//
// A reconnection replaces the entry, so the old connection's cleanup must not
// remove its successor — nor announce a departure that did not happen. That
// false departure is what made a reconnect look to the other side like the
// peer giving up.
func (s *Store) detach(sess *Session, role Role, p *peer) bool {
	sess.mu.Lock()
	defer sess.mu.Unlock()

	removed := sess.peers[role] == p
	if removed {
		delete(sess.peers, role)
	}
	sess.expiresAt = s.now().Add(s.idleTTL)
	return removed
}

// touch extends an active session. Called on relayed traffic so a long
// transfer does not expire underneath itself.
func (s *Store) touch(sess *Session) {
	sess.mu.Lock()
	sess.expiresAt = s.now().Add(s.activeTTL)
	sess.mu.Unlock()
}

func (sess *Session) expired(now time.Time) bool {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return now.After(sess.expiresAt)
}

// peerFor returns the opposite peer, if it is currently connected.
func (sess *Session) peerFor(role Role) (*peer, bool) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	p, ok := sess.peers[role.other()]
	return p, ok
}

func (sess *Session) peerCount() int {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return len(sess.peers)
}
