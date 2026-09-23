package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// ICE configuration, handed to clients at the start of a transfer.
//
// This lives on the server for one reason: TURN credentials. A relay needs
// credentials, and anything shipped to a browser is public — an API token in
// a NEXT_PUBLIC_ variable is simply a published token. So the long-lived
// token stays here and the service mints short-lived credentials per request.
//
// A relay never sees file contents: WebRTC encrypts end to end and the relay
// forwards ciphertext. It does see metadata — addresses, timing, volume — and
// it costs bandwidth, which is why it is a fallback rather than the default
// path.

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type iceResponse struct {
	IceServers []iceServer `json:"iceServers"`
	// Whether a relay is actually available, so a client can say something
	// useful instead of blaming the network for a missing server.
	RelayAvailable bool `json:"relayAvailable"`
}

// iceProvider assembles STUN and, when configured, freshly minted TURN.
type iceProvider struct {
	stunURLs []string

	cfKeyID    string
	cfAPIToken string
	cfTTL      time.Duration

	mu     sync.Mutex
	cached []iceServer
	expiry time.Time

	client *http.Client
}

func newICEProvider() *iceProvider {
	// LookupEnv, not env(): STUN_URLS set to empty means "no STUN", which is a
	// real configuration — a LAN-only deployment, or a test that must not
	// depend on a third party — and is not the same as leaving it unset.
	raw, set := os.LookupEnv("STUN_URLS")
	if !set {
		raw = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
	}
	stun := strings.Split(raw, ",")
	urls := make([]string, 0, len(stun))
	for _, u := range stun {
		if u = strings.TrimSpace(u); u != "" {
			urls = append(urls, u)
		}
	}

	return &iceProvider{
		stunURLs:   urls,
		cfKeyID:    os.Getenv("CF_TURN_KEY_ID"),
		cfAPIToken: os.Getenv("CF_TURN_API_TOKEN"),
		cfTTL:      envDuration("TURN_TTL", 12*time.Hour),
		client:     &http.Client{Timeout: 10 * time.Second},
	}
}

func (p *iceProvider) configured() bool {
	return p.cfKeyID != "" && p.cfAPIToken != ""
}

// servers returns the ICE servers a client should use.
//
// A TURN failure is not fatal: the client still gets STUN and can still
// connect on any network that permits a direct path.
func (p *iceProvider) servers(ctx context.Context) iceResponse {
	res := iceResponse{IceServers: []iceServer{}}
	if len(p.stunURLs) > 0 {
		res.IceServers = append(res.IceServers, iceServer{URLs: p.stunURLs})
	}

	if !p.configured() {
		return res
	}

	turn, err := p.turn(ctx)
	if err != nil || len(turn) == 0 {
		return res
	}

	res.IceServers = append(res.IceServers, turn...)

	// Only claim a relay when one is actually present. The provider returns
	// its STUN endpoint alongside the relay, and a STUN entry says nothing
	// about getting through carrier NAT — claiming otherwise would make the
	// failure message lie about what is configured.
	for _, s := range turn {
		for _, u := range s.URLs {
			if strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") {
				res.RelayAvailable = true
			}
		}
	}
	return res
}

// turn mints credentials, reusing them until they are close to expiring.
// Every transfer asking Cloudflare for its own credential would be pointless
// traffic and pointless rate-limit pressure.
func (p *iceProvider) turn(ctx context.Context) ([]iceServer, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.cached) > 0 && time.Now().Before(p.expiry) {
		return p.cached, nil
	}

	body, _ := json.Marshal(map[string]any{"ttl": int(p.cfTTL.Seconds())})
	url := fmt.Sprintf("https://rtc.live.cloudflare.com/v1/turn/keys/%s/credentials/generate-ice-servers", p.cfKeyID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+p.cfAPIToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("turn credentials: status %d", resp.StatusCode)
	}

	var parsed struct {
		IceServers json.RawMessage `json:"iceServers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, err
	}

	// The provider returns an array — its STUN endpoint and the credentialed
	// relay entries — though the documented example shows a single object.
	// Accept either shape, and keep every entry: taking only the first got
	// us the STUN endpoint and no relay at all.
	var many []iceServer
	if err := json.Unmarshal(parsed.IceServers, &many); err != nil {
		var one iceServer
		if err := json.Unmarshal(parsed.IceServers, &one); err != nil {
			return nil, fmt.Errorf("turn credentials: unexpected shape")
		}
		many = []iceServer{one}
	}

	kept := make([]iceServer, 0, len(many))
	for _, s := range many {
		if len(s.URLs) > 0 {
			kept = append(kept, s)
		}
	}
	if len(kept) == 0 {
		return nil, fmt.Errorf("turn credentials: no urls")
	}

	p.cached = kept
	// Refresh well before expiry so an in-flight transfer never watches its
	// credentials lapse underneath it.
	p.expiry = time.Now().Add(p.cfTTL - p.cfTTL/4)
	return p.cached, nil
}

func (s *server) handleICE(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.ice.servers(r.Context()))
}
